import { statusClass } from './supabase.js'
import { LOGO_B64 } from './invoiceAssets.js'

export function Badge({ status }) {
  return <span className={`badge-s ${statusClass(status)}`}>{status || '—'}</span>
}

export function StatCard({ num, label, color }) {
  return (
    <div className="stat-card">
      <div className="num" style={color ? { color: `var(--${color})` } : {}}>{num}</div>
      <div className="lbl">{label}</div>
    </div>
  )
}

export function Meta({ k, v, style }) {
  return (
    <div className="meta-item">
      <div className="mk">{k}</div>
      <div className="mv" style={style}>{v ?? '—'}</div>
    </div>
  )
}

export function initials(name) {
  return (name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0].toUpperCase()).join('') || '?'
}

export function Shell({ brand, sub, userName, userRole, navSections, active, onNav, onLogout, title, children, topbarExtra }) {
  return (
    <div className="shell">
      <div className="sidebar">
        <div className="sidebar-logo">
          <img src={`data:image/jpeg;base64,${LOGO_B64}`} alt="Learning Tree"
            style={{ display: 'block', width: '48px', height: 'auto', borderRadius: '6px', marginBottom: '8px' }} />
          <div className="brand">{brand}</div>
          <div className="sub">{sub}</div>
        </div>
        <div className="sidebar-user">
          <div className="avatar">{initials(userName)}</div>
          <div>
            <div className="uname">{userName}</div>
            <div className="urole">{userRole}</div>
          </div>
        </div>
        <nav>
          {navSections.map(section => (
            <div key={section.label}>
              <div className="nav-section">{section.label}</div>
              {section.items.map(item => (
                <a key={item.id} className={`nav-link ${active === item.id ? 'active' : ''}`}
                  onClick={() => onNav(item.id)}>
                  <span className="ni">{item.icon}</span> {item.label}
                  {item.badge ? <span className="badge">{item.badge}</span> : null}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer" onClick={onLogout}>⬅ Logout</div>
      </div>
      <div className="main">
        <div className="topbar">
          <div className="topbar-title">{title}</div>
          <div className="topbar-actions">
            {topbarExtra}
            <span style={{ fontSize: 12, color: '#888' }}>
              📅 {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          </div>
        </div>
        <div className="content">{children}</div>
      </div>
    </div>
  )
}
