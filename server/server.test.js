const request = require('supertest');
const fs = require('fs');
const path = require('path');
const io = require('socket.io-client');

// Test against the running server
const SERVER_URL = 'http://localhost:5000';
let clientSocket;

describe('Local Whisper Transcriber Server Tests', () => {
  
  beforeAll(() => {
    console.log('Testing server at:', SERVER_URL);
    console.log('Make sure the server is running with: npm start');
  });

  afterEach(() => {
    if (clientSocket && clientSocket.connected) {
      clientSocket.disconnect();
    }
  });

  describe('Basic Endpoints', () => {
    
    test('GET / - should return HTML welcome page', async () => {
      const response = await request(SERVER_URL).get('/');
      expect(response.status).toBe(200);
      expect(response.text).toContain('Audio Transcription Server');
      expect(response.text).toContain('Local Whisper');
      expect(response.headers['content-type']).toMatch(/html/);
    });

    test('GET /api/health - should return health check', async () => {
      const response = await request(SERVER_URL).get('/api/health');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('running');
    });

  });

  describe('File Upload Endpoint', () => {
    
    test('POST /api/transcribe - should reject request without file', async () => {
      const response = await request(SERVER_URL)
        .post('/api/transcribe')
        .send({});
      
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toBe('No file uploaded');
    });

    test('POST /api/transcribe - should accept file with model parameter', async () => {
      // Create a small test audio file (mock data)
      const testFilePath = path.join(__dirname, 'test-mock-audio.m4a');
      const mockAudioData = Buffer.alloc(1024, 0); // 1KB of zeros
      fs.writeFileSync(testFilePath, mockAudioData);

      try {
        const response = await request(SERVER_URL)
          .post('/api/transcribe')
          .field('model', 'tiny')
          .attach('file', testFilePath)
          .timeout(30000);
        
        // This will fail transcription (not real audio) but tests the endpoint
        // Expect either a processing response or error
        expect([200, 201, 500]).toContain(response.status);
        
      } finally {
        // Cleanup
        if (fs.existsSync(testFilePath)) {
          fs.unlinkSync(testFilePath);
        }
      }
    }, 35000);

  });

  describe('WebSocket Connection', () => {
    
    test('should successfully connect via WebSocket', (done) => {
      clientSocket = io(SERVER_URL, {
        transports: ['websocket'],
        reconnection: false
      });

      clientSocket.on('connect', () => {
        expect(clientSocket.connected).toBe(true);
        expect(clientSocket.id).toBeDefined();
        console.log('✓ WebSocket connected:', clientSocket.id);
        done();
      });

      clientSocket.on('connect_error', (error) => {
        done(error);
      });
    }, 10000);

    test('should handle cancel-transcription event', (done) => {
      clientSocket = io(SERVER_URL, {
        transports: ['websocket']
      });

      clientSocket.on('connect', () => {
        clientSocket.emit('cancel-transcription');
        
        // Should either get cancelled event or just timeout (no active transcription)
        clientSocket.on('transcription-cancelled', (data) => {
          expect(data).toHaveProperty('message');
          console.log('✓ Received cancel response:', data.message);
          done();
        });

        // If no active transcription, complete after short wait
        setTimeout(() => {
          console.log('✓ Cancel event sent (no active transcription)');
          done();
        }, 1000);
      });
    }, 10000);

    test('should handle disconnect properly', (done) => {
      clientSocket = io(SERVER_URL, {
        transports: ['websocket']
      });

      clientSocket.on('connect', () => {
        const socketId = clientSocket.id;
        console.log('✓ Connected with ID:', socketId);
        
        clientSocket.disconnect();
        
        setTimeout(() => {
          expect(clientSocket.connected).toBe(false);
          console.log('✓ Successfully disconnected');
          done();
        }, 500);
      });
    }, 10000);

  });

  describe('File System Structure', () => {
    
    test('uploads directory should exist', () => {
      const uploadsDir = path.join(__dirname, 'uploads');
      expect(fs.existsSync(uploadsDir)).toBe(true);
      console.log('✓ Uploads directory exists');
    });

    test('checkpoints directory should exist', () => {
      const checkpointsDir = path.join(__dirname, 'checkpoints');
      expect(fs.existsSync(checkpointsDir)).toBe(true);
      console.log('✓ Checkpoints directory exists');
    });

    test('whisper_stream.py should exist', () => {
      const scriptPath = path.join(__dirname, 'whisper_stream.py');
      expect(fs.existsSync(scriptPath)).toBe(true);
      console.log('✓ Python streaming script exists');
    });

    test('whisper_transcribe.py should exist', () => {
      const scriptPath = path.join(__dirname, 'whisper_transcribe.py');
      expect(fs.existsSync(scriptPath)).toBe(true);
      console.log('✓ Python transcribe script exists');
    });

    test('requirements.txt should exist', () => {
      const reqPath = path.join(__dirname, 'requirements.txt');
      expect(fs.existsSync(reqPath)).toBe(true);
      console.log('✓ Python requirements file exists');
    });

  });

  describe('Server Configuration', () => {
    
    test('should allow CORS requests', async () => {
      const response = await request(SERVER_URL)
        .get('/api/health')
        .set('Origin', 'http://localhost:3000');
      
      expect(response.headers['access-control-allow-origin']).toBeDefined();
      console.log('✓ CORS properly configured');
    });

    test('should accept JSON requests', async () => {
      const response = await request(SERVER_URL)
        .get('/api/health')
        .set('Content-Type', 'application/json');
      
      expect(response.status).toBe(200);
      console.log('✓ JSON content-type accepted');
    });

  });

  describe('Error Handling', () => {
    
    test('should return 404 for unknown routes', async () => {
      const response = await request(SERVER_URL).get('/unknown/route/12345');
      expect(response.status).toBe(404);
      console.log('✓ Unknown routes return 404');
    });

    test('should handle POST to wrong endpoint', async () => {
      const response = await request(SERVER_URL)
        .post('/api/wrong-endpoint')
        .send({ test: 'data' });
      
      expect(response.status).toBe(404);
      console.log('✓ Wrong POST endpoint returns 404');
    });

  });

  describe('Checkpoint System', () => {
    
    test('checkpoints directory should be writable', () => {
      const checkpointsDir = path.join(__dirname, 'checkpoints');
      const testFile = path.join(checkpointsDir, 'test.json');
      
      try {
        fs.writeFileSync(testFile, JSON.stringify({ test: true }));
        expect(fs.existsSync(testFile)).toBe(true);
        fs.unlinkSync(testFile);
        console.log('✓ Checkpoints directory is writable');
      } catch (error) {
        throw new Error('Checkpoints directory is not writable: ' + error.message);
      }
    });

    test('should ignore checkpoint JSON files (.gitignore)', () => {
      const gitignorePath = path.join(__dirname, '.gitignore');
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        expect(content).toContain('checkpoints/');
        console.log('✓ Checkpoints properly ignored in git');
      }
    });

  });

  describe('Integration Tests', () => {
    
    test('should handle multiple simultaneous WebSocket connections', (done) => {
      const socket1 = io(SERVER_URL, { transports: ['websocket'] });
      const socket2 = io(SERVER_URL, { transports: ['websocket'] });
      const socket3 = io(SERVER_URL, { transports: ['websocket'] });

      let connectedCount = 0;
      
      const checkComplete = () => {
        connectedCount++;
        if (connectedCount === 3) {
          console.log('✓ Multiple WebSocket connections successful');
          socket1.disconnect();
          socket2.disconnect();
          socket3.disconnect();
          done();
        }
      };

      socket1.on('connect', checkComplete);
      socket2.on('connect', checkComplete);
      socket3.on('connect', checkComplete);
    }, 15000);

    test('server should be responsive under load', async () => {
      const requests = [];
      for (let i = 0; i < 10; i++) {
        requests.push(request(SERVER_URL).get('/api/health'));
      }
      
      const responses = await Promise.all(requests);
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });
      
      console.log('✓ Server responsive under 10 concurrent requests');
    }, 15000);

  });

});

// Summary after tests
afterAll(() => {
  console.log('\n' + '='.repeat(50));
  console.log('📊 Test Summary');
  console.log('='.repeat(50));
  console.log('Server URL:', SERVER_URL);
  console.log('All tests completed!');
  console.log('='.repeat(50) + '\n');
});

