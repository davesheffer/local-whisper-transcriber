const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 5000;

// Configure multer for file uploads
const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

app.use(cors());
app.use(express.json());

// Root endpoint
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Audio Transcription Server</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
          h1 { color: #667eea; }
          .endpoint { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 5px; }
          .method { display: inline-block; padding: 5px 10px; border-radius: 3px; font-weight: bold; }
          .get { background: #61affe; color: white; }
          .post { background: #49cc90; color: white; }
          code { background: #e8e8e8; padding: 2px 6px; border-radius: 3px; }
        </style>
      </head>
      <body>
        <h1>🎵 Audio Transcription Server</h1>
        <p>Local Whisper API - Running on port ${PORT}</p>
        
        <h2>Available Endpoints:</h2>
        
        <div class="endpoint">
          <span class="method get">GET</span>
          <strong>/api/health</strong>
          <p>Check if the server is running</p>
        </div>
        
        <div class="endpoint">
          <span class="method post">POST</span>
          <strong>/api/transcribe</strong>
          <p>Transcribe an audio file</p>
          <p><strong>Body:</strong> Form data with <code>file</code> (audio file) and optional <code>model</code> (tiny, base, small, medium, large)</p>
        </div>
        
        <h3>Status: ✅ Server is running</h3>
        <p>Frontend should be running on: <a href="http://localhost:3000">http://localhost:3000</a></p>
      </body>
    </html>
  `);
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Transcription server is running' });
});

// Transcription endpoint
app.post('/api/transcribe', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const filePath = req.file.path;
  const model = req.body.model || 'base'; // tiny, base, small, medium, large

  console.log(`Transcribing file: ${req.file.originalname} with model: ${model}`);

  try {
    // Call Python Whisper script
    const python = spawn('python', [
      path.join(__dirname, 'whisper_transcribe.py'),
      filePath,
      model
    ]);

    let transcription = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      transcription += data.toString();
    });

    python.stderr.on('data', (data) => {
      const output = data.toString();
      errorOutput += output;
      
      // Log progress and other info
      if (output.includes('PROGRESS:') || output.includes('Using device') || 
          output.includes('GPU:') || output.includes('Loading') || 
          output.includes('Transcribing')) {
        console.log(`[Transcription] ${output.trim()}`);
      } else {
        console.error(`Python stderr: ${output}`);
      }
    });

    python.on('close', (code) => {
      // Clean up uploaded file
      fs.unlink(filePath, (err) => {
        if (err) console.error('Error deleting file:', err);
      });

      if (code !== 0) {
        console.error(`Python process exited with code ${code}`);
        return res.status(500).json({ 
          error: 'Transcription failed', 
          details: errorOutput 
        });
      }

      try {
        const result = JSON.parse(transcription);
        res.json(result);
      } catch (e) {
        console.error('Error parsing transcription:', e);
        res.status(500).json({ 
          error: 'Invalid transcription response',
          details: transcription 
        });
      }
    });

  } catch (error) {
    console.error('Transcription error:', error);
    
    // Clean up file on error
    fs.unlink(filePath, (err) => {
      if (err) console.error('Error deleting file:', err);
    });
    
    res.status(500).json({ 
      error: 'Transcription failed', 
      message: error.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Transcription server running on http://localhost:${PORT}`);
  console.log(`📝 Upload endpoint: http://localhost:${PORT}/api/transcribe`);
  console.log(`❤️  Health check: http://localhost:${PORT}/api/health`);
});
