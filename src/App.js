import React, { useState, useRef, useEffect, useCallback } from 'react';
import './App.css';
import axios from 'axios';
import Recorder from './Recorder';
import Recordings from './Recordings';
import useRecordings from './useRecordings';
import useAutoSummarize from './useAutoSummarize';
import { API } from './api';
import {
  ArrowUpTrayIcon,
  MusicalNoteIcon,
  ExclamationTriangleIcon,
  StopIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  XMarkIcon
} from '@heroicons/react/24/outline';

const TABS = [
  { id: 'record', label: 'Record' },
  { id: 'recordings', label: 'Recordings' },
  { id: 'file', label: 'Transcribe a file' },
];

function App() {
  const [tab, setTab] = useState(() => {
    let saved = null;
    try { saved = localStorage.getItem('app.tab'); } catch { /* storage unavailable */ }
    return TABS.some((t) => t.id === saved) ? saved : 'record';
  });
  useEffect(() => {
    try { localStorage.setItem('app.tab', tab); } catch { /* storage unavailable */ }
  }, [tab]);
  const [health, setHealth] = useState({ ok: null, gpu: false });
  const [copied, setCopied] = useState(false);
  const [file, setFile] = useState(null);
  const [transcription, setTranscription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [progressMessage, setProgressMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const [selectedModel, setSelectedModel] = useState('base');
  const [streamingSegments, setStreamingSegments] = useState([]);
  // Recordings screen state lives here so the Record tab can open a recording in it.
  const [selectedId, setSelectedId] = useState(null);
  const [recView, setRecView] = useState('list');
  const [live, setLive] = useState(null);
  const recordingsData = useRecordings();
  // Background AI notes for recordings that finish transcribing while the app is open.
  const autoSummary = useAutoSummarize(recordingsData);
  const { socket } = recordingsData;
  const fileInputRef = useRef(null);
  const transcriptionBoxRef = useRef(null);
  // Stable per-tab id. Unlike socket.id it survives reconnects, so the server
  // can keep routing live updates to us after a dropped-and-restored socket.
  const clientIdRef = useRef(
    (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  // Live file-transcription updates over the shared socket (owned by useRecordings).
  useEffect(() => {
    if (!socket) return;

    const onConnect = () => {
      console.log('[✓] WebSocket connected:', socket.id);
      // Re-register our stable clientId on every (re)connect so the server
      // re-joins us to our room and live updates resume after a blip.
      socket.emit('register', clientIdRef.current);
    };

    const onUpdate = (data) => {
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
    };

    const onDisconnect = (reason) => {
      // A dropped progress socket no longer cancels the job — the server keeps
      // transcribing and delivers the result over the HTTP response. socket.io
      // auto-reconnects, and our 'connect' handler re-registers to resume the
      // live segment stream, so there's nothing to do here but log.
      console.log('[✗] WebSocket disconnected:', reason, '— job keeps running, auto-reconnecting');
    };

    const onCancelled = (data) => {
      console.log('[!] Transcription cancelled');
      setLoading(false);
      setError(data.message || 'Transcription cancelled by user');
      setProgress(0);
      setStreamingSegments([]);
    };

    socket.on('connect', onConnect);
    socket.on('transcription-update', onUpdate);
    socket.on('disconnect', onDisconnect);
    socket.on('transcription-cancelled', onCancelled);
    if (socket.connected) onConnect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('transcription-update', onUpdate);
      socket.off('disconnect', onDisconnect);
      socket.off('transcription-cancelled', onCancelled);
    };
  }, [socket]);

  // Server status pill: poll health every 10 s.
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch(`${API}/api/health`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const gpu = Object.values(j.workers || {}).some((w) => w && w.device === 'cuda');
        if (alive) setHealth({ ok: true, gpu });
      } catch {
        if (alive) setHealth((h) => ({ ok: false, gpu: h.gpu }));
      }
    };
    check();
    const timer = setInterval(check, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const onTabKey = (e) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let n;
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    else return;
    e.preventDefault();
    const next = TABS[n].id;
    setTab(next);
    const el = document.getElementById(`tab-${next}`);
    if (el) el.focus();
  };

  const openRecording = useCallback((id) => {
    setSelectedId(id);
    setRecView('detail');
    setTab('recordings');
  }, []);
  const goRecord = useCallback(() => setTab('record'), []);

  const handleCancelTranscription = () => {
    if (socket && loading) {
      socket.emit('cancel-transcription');
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
        `${API}/api/warmup`,
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
    const okType = ['audio/m4a', 'audio/x-m4a', 'audio/mp4', 'video/mp4', 'audio/ogg', 'video/ogg', 'application/ogg'].includes(droppedFile?.type);
    const okExt = ['.m4a', '.mp4', '.ogg', '.oga', '.opus'].some((ext) => name.endsWith(ext));
    if (droppedFile && (okType || okExt)) {
      setFile(droppedFile);
      setError('');
      setTranscription('');
    } else {
      setError('Please drop a valid M4A, MP4, or OGG file');
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
        `${API}/api/transcribe`,
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
    { value: 'tiny', label: 'Fastest', desc: '~1-3 min' },
    { value: 'base', label: 'Balanced', desc: '~3-8 min' },
    { value: 'small', label: 'More accurate', desc: '~5-12 min' },
    { value: 'medium', label: 'Most accurate (slow)', desc: '~10-20 min' },
    { value: 'large-v3-turbo', label: 'Turbo (fast + best)', desc: '~5-10 min' },
    { value: 'large-v3', label: 'Large (best, slow)', desc: '~20-40 min' },
  ];

  const copyToClipboard = () => {
    navigator.clipboard.writeText(transcription).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const downloadTxt = () => {
    const url = URL.createObjectURL(new Blob([transcription], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(file?.name || 'transcript').replace(/\.[^.]+$/, '')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="App">
      <div className={`container ${tab === 'recordings' ? 'wide' : ''}`}>
        <header className="header">
          <h1>Meeting Transcriber</h1>
          <span className={`status-pill ${health.ok === false ? 'down' : health.ok ? 'up' : 'wait'}`} role="status">
            <span className="status-dot" aria-hidden="true" />
            {health.ok === false ? 'Server offline' : health.ok ? `Ready${health.gpu ? ' · GPU' : ''}` : 'Connecting…'}
          </span>
        </header>

        <div className="tabs" role="tablist" aria-label="Mode">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)} onKeyDown={onTabKey}>
              {t.label}
            </button>
          ))}
        </div>

        {/* All panels stay mounted (hidden when inactive) so a recording in progress survives tab switches. */}
        <div role="tabpanel" id="panel-record" aria-labelledby="tab-record" className="tab-panel" hidden={tab !== 'record'}>
          <Recorder
            active={tab === 'record'}
            serverDown={recordingsData.serverDown}
            refresh={recordingsData.refresh}
            transcribe={recordingsData.transcribe}
            onOpenRecording={openRecording}
            onLiveChange={setLive}
          />
        </div>

        <div role="tabpanel" id="panel-recordings" aria-labelledby="tab-recordings" className="tab-panel" hidden={tab !== 'recordings'}>
          <Recordings
            data={recordingsData}
            selectedId={selectedId}
            onSelect={setSelectedId}
            view={recView}
            onView={setRecView}
            onGoRecord={goRecord}
            live={live}
            auto={autoSummary}
          />
        </div>

        <div role="tabpanel" id="panel-file" aria-labelledby="tab-file" className="tab-panel" hidden={tab !== 'file'}>

        {!file && (
          <div className="field model-field">
            <label htmlFor="file-accuracy">Accuracy</label>
            <select id="file-accuracy" value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}>
              {modelOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label} ({option.desc})</option>
              ))}
            </select>
          </div>
        )}

        <div
          className={`dropzone ${isDragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            id="file-input"
            type="file"
            ref={fileInputRef}
            onChange={handleFileInput}
            accept=".m4a,.mp4,.ogg,.oga,.opus,audio/m4a,audio/x-m4a,audio/mp4,video/mp4,audio/ogg,video/ogg,application/ogg"
            className="visually-hidden"
            aria-label="Choose an audio file"
          />

          {!file ? (
            <>
              <div className="upload-icon"><ArrowUpTrayIcon aria-hidden="true" /></div>
              <p className="dropzone-text">
                Drop an audio file here or{' '}
                <button type="button" className="link-btn" onClick={() => fileInputRef.current?.click()}>choose a file</button>
              </p>
              <p className="dropzone-subtext">M4A, MP4, OGG, OGA or OPUS</p>
            </>
          ) : (
            <>
              <div className="file-icon"><MusicalNoteIcon aria-hidden="true" /></div>
              <p className="file-name" dir="auto">{file.name}</p>
              <p className="file-size">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
              <button type="button" className="icon-btn clear-btn" aria-label="Remove file" title="Remove file" onClick={handleClearFile}>
                <XMarkIcon aria-hidden="true" />
              </button>
            </>
          )}
        </div>

        {error && (
          <div className="error-message" role="alert">
            <ExclamationTriangleIcon className="error-icon" aria-hidden="true" /> <span>{error}</span>
          </div>
        )}

        {file && !transcription && (
          <>
            {!loading ? (
              <button type="button" className="primary-btn big" onClick={handleTranscribe}>
                Transcribe file
              </button>
            ) : (
              <button type="button" className="ghost-btn danger big" onClick={handleCancelTranscription}>
                <StopIcon aria-hidden="true" /> Stop transcription
              </button>
            )}

            {loading && (
              <div className="progress-section" aria-live="polite">
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

        {streamingSegments.length > 0 && !transcription && (
          <div className="streaming-box" ref={transcriptionBoxRef}>
            <div className="streaming-header">
              <h3>Live transcript</h3>
              <span className="live-badge"><span className="live-dot" aria-hidden="true">●</span> Live</span>
            </div>
            <div className="streaming-content" dir="auto">
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
          <div className="transcription-result rec-item">
            <div className="result-header">
              <h2>Transcript</h2>
            </div>
            <div className="transcription-text" dir="auto">
              {transcription}
            </div>
            <div className="rec-actions">
              <button type="button" className="primary-btn" onClick={copyToClipboard}>{copied ? 'Copied ✓' : 'Copy text'}</button>
              <button type="button" className="ghost-btn" onClick={downloadTxt}><ArrowDownTrayIcon aria-hidden="true" />Download .txt</button>
              <button type="button" className="ghost-btn" onClick={handleClearFile}><ArrowPathIcon aria-hidden="true" />Transcribe another file</button>
            </div>
          </div>
        )}

        {!file && !transcription && (
          <p className="info-footer">Private and free. Runs locally on this computer.</p>
        )}
        </div>
      </div>
    </div>
  );
}

export default App;
