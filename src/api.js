// The production build is served by the Node server itself, so the API is same-origin.
// In dev (`npm start` on :3000) the server runs separately on :5000.
export const API = process.env.NODE_ENV === 'production'
  ? window.location.origin
  : 'http://localhost:5000';
