# 🎵 Audio Transcriber (Local Whisper)

A React application for transcribing M4A audio files using OpenAI's Whisper model **running locally on your machine**. No API keys needed, completely private!

## Features

- 📁 Drag and drop M4A file support
- 🎤 Local Whisper AI transcription (no cloud, no API costs)
- 📋 Copy transcription to clipboard
- 💎 Beautiful, modern UI
- ⚡ Fast and responsive
- 🔒 100% Private - audio never leaves your machine

## Prerequisites

- **Node.js** (v14 or higher)
- **Python** (v3.8 or higher)
- **pip** (Python package manager)

## Setup

### 1. Install Python Dependencies

```bash
cd server
pip install -r requirements.txt
```

This will install OpenAI Whisper and its dependencies. First run may take a few minutes.

### 2. Install Node.js Dependencies

**Backend:**
```bash
cd server
npm install
```

**Frontend:**
```bash
cd ..
npm install
```

### 3. Start the Backend Server

```bash
cd server
npm start
```

The server will run on `http://localhost:5000`

### 4. Start the React Frontend

Open a new terminal:
```bash
npm start
```

The app will open at `http://localhost:3000`

## Usage

1. Make sure backend server is running
2. Drag and drop an M4A audio file onto the dropzone (or click to browse)
3. Click "Transcribe Audio" button
4. Wait for the transcription to complete (first run downloads the model)
5. Copy or save the transcribed text

## Whisper Models

The app uses the `base` model by default. You can change this in the code:

- **tiny** - Fastest, least accurate (~1GB RAM)
- **base** - Good balance (default, ~1GB RAM)
- **small** - Better accuracy (~2GB RAM)
- **medium** - High accuracy (~5GB RAM)
- **large** - Best accuracy (~10GB RAM)

To change the model, edit `server/server.js` line 18 or `src/App.js` line 68.

## Supported Audio Formats

- M4A (primary format)
- MP3, MP4, WAV, WEBM, and more

## Technologies Used

- **Frontend**: React 18, Axios
- **Backend**: Node.js, Express, Multer
- **AI**: OpenAI Whisper (local)
- **Python**: whisper library

## Troubleshooting

**"Python not found"**
- Make sure Python is installed and added to PATH
- Try `python3` instead of `python` in server.js

**"Module not found: whisper"**
- Run `pip install openai-whisper` in the server directory

**Server not connecting**
- Make sure backend server is running on port 5000
- Check if another app is using port 5000

**First transcription is slow**
- Whisper downloads the model on first use (~100-500MB depending on model)
- Subsequent transcriptions will be much faster

## Privacy & Performance

✅ **100% Local** - Audio files never leave your computer
✅ **No API Costs** - Completely free to use
✅ **Offline Capable** - Works without internet (after model download)
✅ **Fast** - Direct processing on your machine

## Notes

- First run downloads the Whisper model (~140MB for base model)
- Processing time depends on audio length and your CPU/GPU
- GPU acceleration available if you have CUDA-enabled GPU
