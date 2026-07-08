import React, { useState, useRef, useEffect } from 'react';
import './App.css';
import axios from 'axios';
import io from 'socket.io-client';
import { 
  ArrowUpTrayIcon, 
  MusicalNoteIcon, 
  ExclamationTriangleIcon,
  PlayIcon,
  StopIcon,
  DocumentTextIcon,
  ClipboardDocumentIcon,
  ArrowPathIcon,
  InformationCircleIcon
} from '@heroicons/react/24/outline';

function App() {
  const [file, setFile] = useState(null);
  const [transcription, setTranscription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [progressMessage, setProgressMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const [selectedModel, setSelectedModel] = useState('base');
  const [streamingSegments, setStreamingSegments] = useState([]);
  const fileInputRef = useRef(null);
  const socketRef = useRef(null);
  const transcriptionBoxRef = useRef(null);
  // Stable per-tab id. Unlike socket.id it survives reconnects, so the server
  // can keep routing live updates to us after a dropped-and-restored socket.
  const clientIdRef = useRef(
    (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  // Initialize WebSocket connection
  useEffect(() => {
    socketRef.current = io('http://localhost:5000');

    socketRef.current.on('connect', () => {
      console.log('[✓] WebSocket connected:', socketRef.current.id);
      // Re-register our stable clientId on every (re)connect so the server
      // re-joins us to our room and live updates resume after a blip.
      socketRef.current.emit('register', clientIdRef.current);
    });

    socketRef.current.on('transcription-update', (data) => {
      console.log('[↓] Received update:', data);
      
      if (data.type === 'status' || data.type === 'info') {
        const msg = data.message || (data.total_chunks ? `Processing ${data.total_chunks} chunks...` : 'Processing...');
        setProgressMessage(msg);
        console.log('Status:', msg);
      } else if (data.type === 'progress') {
        setProgress(data.percent);
        const label = data.total_chunks && data.total_chunks > 0
          ? `Processing chunk ${data.chunk}/${data.total_chunks}`
          : `Transcribing... ${data.percent}%`;
        setProgressMessage(label);
        console.log(`Progress: ${data.percent}%`);
      } else if (data.type === 'segment') {
        console.log('[+] New segment:', data.text.substring(0, 100));
        // Add new segment to streaming display
        setStreamingSegments(prev => [...prev, {
          id: data.chunk,
          text: data.text,
          new: true
        }]);
        
        // Auto-scroll to bottom
        setTimeout(() => {
          if (transcriptionBoxRef.current) {
            transcriptionBoxRef.current.scrollTop = transcriptionBoxRef.current.scrollHeight;
          }
        }, 100);
        
        // Remove "new" highlight after 3 seconds
        setTimeout(() => {
          setStreamingSegments(prev => 
            prev.map(seg => seg.id === data.chunk ? {...seg, new: false} : seg)
          );
        }, 3000);
      } else if (data.type === 'complete') {
        setTranscription(data.text);
        setLoading(false);
        setProgress(100);
        setProgressMessage('[✓] Complete!');
      } else if (data.type === 'error') {
        setError(data.error || data.message);
        setLoading(false);
        setProgress(0);
      }
    });

    socketRef.current.on('disconnect', (reason) => {
      // A dropped progress socket no longer cancels the job — the server keeps
      // transcribing and delivers the result over the HTTP response. socket.io
      // auto-reconnects, and our 'connect' handler re-registers to resume the
      // live segment stream, so there's nothing to do here but log.
      console.log('[✗] WebSocket disconnected:', reason, '— job keeps running, auto-reconnecting');
    });

    socketRef.current.on('transcription-cancelled', (data) => {
      console.log('[!] Transcription cancelled');
      setLoading(false);
      setError(data.message || 'Transcription cancelled by user');
      setProgress(0);
      setStreamingSegments([]);
    });

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCancelTranscription = () => {
    if (socketRef.current && loading) {
      socketRef.current.emit('cancel-transcription');
      setLoading(false);
      setProgress(0);
      setProgressMessage('');
      setError('Transcription cancelled');
    }
  };

  // Pre-load the chosen model so the first transcription starts instantly.
  // Debounced so rapid clicks through the model selector don't kick off
  // multiple heavy loads on the server.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      axios.post(
        'http://localhost:5000/api/warmup',
        { model: selectedModel },
        { signal: controller.signal, timeout: 600000 }
      ).then(() => {
        console.log(`[✓] Model "${selectedModel}" warmed`);
      }).catch((err) => {
        if (axios.isCancel(err) || err.code === 'ERR_CANCELED') return;
        console.warn('Warmup failed (will load on first use):', err.message);
      });
    }, 600);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [selectedModel]);

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    
    const droppedFile = e.dataTransfer.files[0];
    const name = droppedFile?.name.toLowerCase() || '';
    const okType = ['audio/m4a', 'audio/x-m4a', 'audio/mp4', 'video/mp4'].includes(droppedFile?.type);
    if (droppedFile && (okType || name.endsWith('.m4a') || name.endsWith('.mp4'))) {
      setFile(droppedFile);
      setError('');
      setTranscription('');
    } else {
      setError('Please drop a valid M4A or MP4 file');
    }
  };

  const handleFileInput = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      setFile(selectedFile);
      setError('');
      setTranscription('');
    }
  };

  const handleTranscribe = async () => {
    if (!file) {
      setError('Please select a file first');
      return;
    }

    setLoading(true);
    setError('');
    setTranscription('');
    setProgress(0);
    setStreamingSegments([]);
    setProgressMessage('Connecting to server...');

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('model', selectedModel);
      formData.append('clientId', clientIdRef.current);

      setProgressMessage('Uploading file...');

      // Call local Whisper server with streaming support
      const response = await axios.post(
        'http://localhost:5000/api/transcribe',
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
          timeout: 7200000, // 2 hours for very long files
          onUploadProgress: (progressEvent) => {
            const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            if (percentCompleted < 100) {
              setProgressMessage(`Uploading: ${percentCompleted}%`);
            } else {
              setProgressMessage('Processing - this may take several minutes for large models...');
            }
          },
        }
      );

      // Backup in case WebSocket missed the final message
      if (!transcription && response.data.text) {
        setTranscription(response.data.text);
        setLoading(false);
        setProgress(100);
      }
    } catch (err) {
      console.error('Transcription error:', err);
      
      // Check if it's a timeout error
      if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
        console.log('[⏱] Timeout detected, progress saved. You can re-upload the same file to resume.');
        setError('Processing timeout - Progress saved! Re-upload the same file to resume from checkpoint.');
        setProgressMessage('Timeout - progress saved in checkpoint');
      } else {
        const errorMsg = err.response?.data?.error 
          || err.response?.data?.details
          || err.message 
          || 'Failed to transcribe audio. Make sure the server is running.';
        setError(errorMsg);
        setProgressMessage('');
      }
      
      setProgress(0);
      setLoading(false);
    }
  };

  const handleClearFile = () => {
    setFile(null);
    setTranscription('');
    setError('');
    setProgress(0);
    setProgressMessage('');
    setStreamingSegments([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const modelOptions = [
    { value: 'tiny', label: 'Tiny', desc: 'Fastest (~1-3 min)', size: '39M' },
    { value: 'base', label: 'Base', desc: 'Balanced (~3-8 min)', size: '74M' },
    { value: 'small', label: 'Small', desc: 'Better (~5-12 min)', size: '244M' },
    { value: 'medium', label: 'Medium', desc: 'High (~10-20 min)', size: '769M' },
    { value: 'large-v3-turbo', label: 'Turbo', desc: 'Fast + best (~5-10 min)', size: '809M' },
    { value: 'large-v3', label: 'Large', desc: 'Best (~20-40 min)', size: '1550M' },
  ];

  const copyToClipboard = () => {
    navigator.clipboard.writeText(transcription);
  };

  return (
    <div className="App">
      <div className="container">
        <div className="header">
          <h1><MusicalNoteIcon className="title-icon" /> Audio Transcriber</h1>
          <div className="badges">
            <span className="badge badge-hebrew">Hebrew</span>
            <span className="badge badge-gpu">GPU</span>
          </div>
        </div>

        {!file && (
          <div className="model-selector">
            <label>Transcription Quality:</label>
            <div className="model-options">
              {modelOptions.map(option => (
                <div
                  key={option.value}
                  className={`model-option ${selectedModel === option.value ? 'selected' : ''}`}
                  onClick={() => setSelectedModel(option.value)}
                >
                  <div className="model-label">{option.label}</div>
                  <div className="model-desc">{option.desc}</div>
                  <div className="model-size">{option.size}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div
          className={`dropzone ${isDragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => !file && fileInputRef.current?.click()}
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileInput}
            accept=".m4a,.mp4,audio/m4a,audio/x-m4a,audio/mp4,video/mp4"
            style={{ display: 'none' }}
          />
          
          {!file ? (
            <>
              <div className="upload-icon"><ArrowUpTrayIcon /></div>
              <p className="dropzone-text">Drag & Drop M4A or MP4 file</p>
              <p className="dropzone-subtext">or click to browse</p>
            </>
          ) : (
            <>
              <div className="file-icon"><MusicalNoteIcon /></div>
              <p className="file-name">{file.name}</p>
              <p className="file-size">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
              <button className="clear-btn" onClick={(e) => { e.stopPropagation(); handleClearFile(); }}>
                ✕
              </button>
            </>
          )}
        </div>

        {error && (
          <div className="error-message">
            <ExclamationTriangleIcon className="error-icon" /> {error}
          </div>
        )}

        {file && !transcription && (
          <>
            {!loading ? (
              <button
                className="transcribe-btn"
                onClick={handleTranscribe}
              >
                <PlayIcon className="btn-icon" /> Start Transcription
              </button>
            ) : (
              <button
                className="stop-btn"
                onClick={handleCancelTranscription}
              >
                <StopIcon className="btn-icon" /> Stop Transcription
              </button>
            )}
            
            {loading && (
              <div className="progress-section">
                <div className="progress-bar-container">
                  <div className="progress-bar" style={{ width: `${progress}%` }}></div>
                </div>
                <div className="progress-info">
                  <span className="progress-percent">{progress}%</span>
                  <span className="progress-message">{progressMessage}</span>
                </div>
              </div>
            )}
          </>
        )}

        {streamingSegments.length > 0 && (
          <div className="streaming-box" ref={transcriptionBoxRef}>
            <div className="streaming-header">
              <h3><span className="live-dot">●</span> Live Transcription</h3>
              <span className="live-badge">LIVE</span>
            </div>
            <div className="streaming-content">
              {streamingSegments.map((segment, index) => (
                <span 
                  key={segment.id} 
                  className={segment.new ? 'segment-new' : 'segment'}
                >
                  {segment.text}
                  {index < streamingSegments.length - 1 ? ' ' : ''}
                </span>
              ))}
            </div>
          </div>
        )}

        {transcription && (
          <div className="transcription-result">
            <div className="result-header">
              <h2><DocumentTextIcon className="header-icon" /> Transcription</h2>
              <button className="copy-btn" onClick={copyToClipboard}>
                <ClipboardDocumentIcon className="btn-icon" /> Copy
              </button>
            </div>
            <div className="transcription-text">
              {transcription}
            </div>
            <button className="new-transcription-btn" onClick={handleClearFile}>
              <ArrowPathIcon className="btn-icon" /> Transcribe Another File
            </button>
          </div>
        )}

        {!file && !transcription && (
          <div className="info-footer">
            <p><InformationCircleIcon className="info-icon" /> Private & Free • No API Keys • Runs Locally</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
