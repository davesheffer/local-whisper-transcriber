# Server Tests

Comprehensive test suite for the Local Whisper Transcriber server.

## Prerequisites

- Server must be running on `http://localhost:5000`
- Node.js and npm installed
- All dependencies installed

## Installation

Install test dependencies:

```bash
npm install
```

This will install:
- `jest` - Testing framework
- `supertest` - HTTP testing library
- `socket.io-client` - WebSocket testing client

## Running Tests

### Run all tests:
```bash
npm test
```

### Run tests in watch mode:
```bash
npm run test:watch
```

### Run with coverage:
```bash
npm test -- --coverage
```

## Test Structure

### Basic Endpoints
- ✓ GET / - Welcome page
- ✓ GET /api/health - Health check

### File Upload
- ✓ POST /api/transcribe - File upload validation
- ⊘ POST /api/transcribe - Full transcription (skipped - requires real audio file)
- ✓ Model parameter handling

### WebSocket
- ✓ Connection establishment
- ✓ Cancel transcription event
- ✓ Disconnect handling
- ✓ Multiple concurrent connections

### File System
- ✓ Directory structure validation
- ✓ Python scripts existence
- ✓ Checkpoint management

### Error Handling
- ✓ 404 for unknown routes
- ✓ Invalid request handling

### Integration
- ✓ Multiple simultaneous connections
- ✓ Server responsiveness under load

## Test Coverage

The test suite covers:
- REST API endpoints
- WebSocket communication
- File upload/download
- Checkpoint system
- Error handling
- CORS configuration
- Security measures
- Python script integration

## Notes

1. **Server must be running**: Start the server before running tests:
   ```bash
   npm start
   ```

2. **Port configuration**: Tests expect server on port 5000. Modify `SERVER_URL` in test file if different.

3. **Skipped tests**: One test is skipped (full file transcription) as it requires a real audio file and would timeout with mock data. This is expected behavior.

4. **Test audio files**: Tests create temporary mock audio files that are automatically cleaned up.

5. **Timeouts**: Some tests have extended timeouts (10-15s) to account for connection operations.

## CI/CD Integration

Add to CI pipeline:

```yaml
- name: Install dependencies
  run: cd server && npm install

- name: Start server
  run: cd server && npm start &
  
- name: Wait for server
  run: sleep 5

- name: Run tests
  run: cd server && npm test
```

## Troubleshooting

**Tests failing with connection errors?**
- Ensure server is running on port 5000
- Check firewall settings
- Verify no other process is using port 5000

**Tests timeout?**
- Increase timeout values in jest.config.js
- Check server logs for errors

**WebSocket tests fail?**
- Verify socket.io is properly configured
- Check CORS settings

## Contributing

When adding new features, please add corresponding tests to maintain coverage.
