import React, { useState, useRef } from 'react';
import './App.css';
import axios from 'axios';

function App() {
  const [file, setFile] = useState(null);
  const [transcription, setTranscription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [progressMessage, setProgressMessage] = useState('');
  const fileInputRef = useRef(null);

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
    if (droppedFile && (droppedFile.type === 'audio/m4a' || droppedFile.type === 'audio/mp4' || droppedFile.name.endsWith('.m4a'))) {
      setFile(droppedFile);
      setError('');
      setTranscription('');
    } else {
      setError('Please drop a valid M4A audio file');
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
    setProgressMessage('Uploading file...');

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('model', 'base'); // Options: tiny, base, small, medium, large

      setProgressMessage('Loading AI model...');

      // Call local Whisper server
      const response = await axios.post(
        'http://localhost:5000/api/transcribe',
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
          onUploadProgress: (progressEvent) => {
            const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            setProgressMessage(`Uploading: ${percentCompleted}%`);
          },
        }
      );

      setProgressMessage('Transcription complete!');
      setTranscription(response.data.text);
    } catch (err) {
      console.error('Transcription error:', err);
      const errorMsg = err.response?.data?.error 
        || err.response?.data?.details
        || err.message 
        || 'Failed to transcribe audio. Make sure the server is running.';
      setError(errorMsg);
      setProgressMessage('');
    } finally {
      setLoading(false);
    }
  };

  const handleClearFile = () => {
    setFile(null);
    setTranscription('');
    setError('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(transcription);
  };

  return (
    <div className="App">
      <div className="container">
        <h1>🎵 Audio Transcriber</h1>
        <p className="subtitle">Drop your M4A file to transcribe it</p>

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
            accept=".m4a,audio/m4a,audio/mp4"
            style={{ display: 'none' }}
          />
          
          {!file ? (
            <>
              <div className="upload-icon">📁</div>
              <p className="dropzone-text">Drag & Drop your M4A file here</p>
              <p className="dropzone-subtext">or click to browse</p>
            </>
          ) : (
            <>
              <div className="file-icon">🎵</div>
              <p className="file-name">{file.name}</p>
              <p className="file-size">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
              <button className="clear-btn" onClick={(e) => { e.stopPropagation(); handleClearFile(); }}>
                ✕ Remove
              </button>
            </>
          )}
        </div>

        {error && (
          <div className="error-message">
            ⚠️ {error}
          </div>
        )}

        {file &&<div className="progress-container">
                  <div className="progress-text">{progressMessage || 'Transcribing...'}</div>
                  <div className="progress-subtext">
                    🚀 Using GPU acceleration • This may take a few minutes
                  </div>
                </div> && (
          <button
            className="transcribe-btn"
            onClick={handleTranscribe}
            disabled={loading}
          >
            {loading ? (
              <>
                <span className="spinner"></span>
                Transcribing...
              </>
            ) : (
              '🎤 Transcribe Audio'
            )}
          </button>
        )}

        {transcription && (
          <div className="transcription-result">
            <div className="result-header">
              <h2>📝 Transcription</h2>
              <button className="copy-btn" onClick={copyToClipboard}>
                📋 Copy
              </button>
            </div>
            <div className="transcription-text">
              {transcription}
            </div>
            <button className="new-transcription-btn" onClick={handleClearFile}>
              🔄 Transcribe Another File
            </button>
          </div>
        )}

        <div className="instructions">
          <h3>📖 Instructions</h3>
          <ol>
            <li>Start the backend server: <code>cd server && npm start</code></li>
            <li>Drag and drop an M4A audio file or click to browse</li>
            <li>Click "Transcribe Audio" to get the text (runs locally!)</li>
          </ol>
          <p style={{marginTop: '15px', fontSize: '0.9rem', color: '#666'}}>
            💡 Using local Whisper - no API keys needed, completely private!
          </p>
          <p style={{marginTop: '8px', fontSize: '0.9rem', color: '#667eea', fontWeight: '600'}}>
            🇮🇱 Hebrew is default language • 🚀 GPU acceleration enabled
          </p>
        </div>
      </div>
    </div>
  );
}

export default App;
