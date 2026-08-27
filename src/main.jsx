import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

// Catches any render error so a single broken component shows a readable message
// instead of blanking the whole portal (which looks like the page failed to load).
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) { console.error('Portal render error:', error, info) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1e2a44', padding: 20 }}>
        <div style={{ background: '#fff', borderRadius: 10, maxWidth: 640, width: '100%', padding: '24px 28px', boxShadow: '0 8px 32px rgba(0,0,0,.3)', fontFamily: 'system-ui, sans-serif' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#1e2a44', marginBottom: 8 }}>Something went wrong loading this page</div>
          <p style={{ fontSize: 14, color: '#444', margin: '0 0 14px' }}>
            The portal hit an unexpected error. Try reloading; if it keeps happening, send this message to support:
          </p>
          <pre style={{ background: '#f4f6f8', border: '1px solid #e2e6ea', borderRadius: 6, padding: '10px 12px', fontSize: 12, color: '#a12a2a', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '0 0 16px', maxHeight: 220, overflow: 'auto' }}>
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <button onClick={() => window.location.reload()}
            style={{ background: '#1a56a0', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
