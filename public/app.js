// Global variables
let activeTab = 'tab-overview';
let userProfiles = [];
let pollingInterval = null;

// Tab Routing titles
const TAB_TITLES = {
  'tab-overview': { title: 'Dashboard Overview', subtitle: 'System metrics, real-time activity, and performance.' },
  'tab-memory': { title: 'Long-Term Memory Profiles', subtitle: 'Explore and manage cognitive profiles of group members.' },
  'tab-router': { title: 'Model Routing Registry', subtitle: 'Dynamic list of discovered free models from OpenRouter.' }
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  startPolling();
  fetchInitialData();
  setupActionListeners();
});

// Setup sidebar navigation click events
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetTab = item.getAttribute('data-tab');
      if (targetTab === activeTab) return;

      // Update Active Navigation Item
      navItems.forEach(nav => nav.classList.remove('active'));
      item.classList.add('active');

      // Update Visible Pane
      document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
      document.getElementById(targetTab).classList.add('active');

      // Update Headings
      activeTab = targetTab;
      document.getElementById('view-title').textContent = TAB_TITLES[activeTab].title;
      document.getElementById('view-subtitle').textContent = TAB_TITLES[activeTab].subtitle;

      // Load specific tab data
      if (activeTab === 'tab-memory') fetchUsers();
      if (activeTab === 'tab-router') fetchModels();
    });
  });

  // Start real-time clock
  setInterval(updateLiveClock, 1000);
}

function updateLiveClock() {
  const clockElement = document.getElementById('live-time');
  const now = new Date();
  clockElement.innerHTML = `<i class="ri-time-line"></i> ${now.toUTCString().replace('GMT', 'UTC')}`;
}

// ------------------------------------------------------------------------------
// Polling & Metrics
// ------------------------------------------------------------------------------
function startPolling() {
  // Poll status and logs every 3 seconds
  fetchStatusAndLogs();
  pollingInterval = setInterval(fetchStatusAndLogs, 3000);
}

async function fetchStatusAndLogs() {
  try {
    const [statusRes, logsRes] = await Promise.all([
      fetch('/api/status'),
      fetch('/api/logs')
    ]);

    if (statusRes.ok) {
      const stats = await statusRes.json();
      updateMetricCards(stats);
    }
    
    if (logsRes.ok) {
      const logs = await logsRes.json();
      renderLogs(logs);
    }
  } catch (error) {
    console.error('Error polling status/logs:', error);
  }
}

function updateMetricCards(stats) {
  // Status indicator
  const indicator = document.getElementById('indicator-dot');
  const statusText = document.getElementById('agent-status-text');
  
  indicator.className = 'indicator-dot';
  if (stats.status === 'ACTIVE') {
    indicator.classList.add('active');
    statusText.textContent = 'Agent ACTIVE';
  } else if (stats.status === 'OBSERVING_LIVE') {
    indicator.classList.add('observing');
    statusText.textContent = 'OBSERVING LIVE';
  } else {
    statusText.textContent = 'Agent IDLE';
  }

  // Format Uptime
  const uptimeSec = stats.uptime;
  let uptimeString = `${uptimeSec}s`;
  if (uptimeSec > 3600) {
    uptimeString = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
  } else if (uptimeSec > 60) {
    uptimeString = `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`;
  }
  
  document.getElementById('stat-uptime').textContent = uptimeString;
  document.getElementById('stat-messages').textContent = stats.total_messages_processed;
  document.getElementById('stat-memory').textContent = `${stats.memory_rss} MB`;
  document.getElementById('stat-platform').textContent = stats.platform.toUpperCase();
}

function renderLogs(logs) {
  const consoleBody = document.getElementById('log-console');
  if (!logs || logs.length === 0) {
    consoleBody.innerHTML = '<div class="log-line system">[SYSTEM] No event logs in database.</div>';
    return;
  }

  // Map and join logs
  const html = logs.map(log => {
    const time = new Date(log.timestamp).toLocaleTimeString();
    const category = log.category.toLowerCase();
    return `
      <div class="log-line">
        <span class="log-time">[${time}]</span>
        <span class="log-tag ${category}">${log.category}</span>
        <span>${escapeHTML(log.message)}</span>
      </div>
    `;
  }).reverse().join('');

  // Save scroll position check
  const isScrolledToBottom = consoleBody.scrollHeight - consoleBody.clientHeight <= consoleBody.scrollTop + 50;
  consoleBody.innerHTML = html;
  
  if (isScrolledToBottom) {
    consoleBody.scrollTop = consoleBody.scrollHeight;
  }
}

// ------------------------------------------------------------------------------
// Long Memory Profiles
// ------------------------------------------------------------------------------
async function fetchUsers() {
  const container = document.getElementById('user-cards-container');
  try {
    const res = await fetch('/api/users');
    if (!res.ok) throw new Error('Failed to fetch user profiles');
    userProfiles = await res.json();
    renderUserCards(userProfiles);
  } catch (error) {
    container.innerHTML = `<div class="card-loader text-danger">Error: ${error.message}</div>`;
  }
}

function renderUserCards(users) {
  const container = document.getElementById('user-cards-container');
  if (!users || users.length === 0) {
    container.innerHTML = '<div class="card-loader">No active user memories saved yet. Talk to the bot to create memory profiles.</div>';
    return;
  }

  const html = users.map(user => {
    const initials = user.name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
    
    const interests = user.interests.map(i => `<span class="badge badge-interest">${escapeHTML(i)}</span>`).join('');
    const skills = user.skills.map(s => `<span class="badge badge-skill">${escapeHTML(s)}</span>`).join('');
    const facts = user.facts.map(f => `<li><i class="ri-checkbox-blank-circle-fill"></i> <span>${escapeHTML(f)}</span></li>`).join('');

    return `
      <div class="user-card">
        <div class="user-header">
          <div class="user-avatar">${initials}</div>
          <div class="user-info">
            <h3>${escapeHTML(user.name)}</h3>
            <span>ID: ${user.user_id}</span>
          </div>
        </div>

        <div class="user-meta-section">
          <span class="meta-title">Interests</span>
          <div class="badge-group">${interests || '<span class="badge">None</span>'}</div>
        </div>

        <div class="user-meta-section">
          <span class="meta-title">Skills & Tech</span>
          <div class="badge-group">${skills || '<span class="badge">None</span>'}</div>
        </div>

        <div class="user-meta-section">
          <span class="meta-title">Extracted Facts</span>
          <ul class="facts-list">
            ${facts || '<li><span class="text-muted">No facts saved.</span></li>'}
          </ul>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
}

// Search Filter
document.getElementById('user-search').addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase();
  const filtered = userProfiles.filter(user => {
    return user.name.toLowerCase().includes(query) ||
           user.facts.some(f => f.toLowerCase().includes(query)) ||
           user.interests.some(i => i.toLowerCase().includes(query)) ||
           user.skills.some(s => s.toLowerCase().includes(query));
  });
  renderUserCards(filtered);
});

// ------------------------------------------------------------------------------
// Model Router Registry
// ------------------------------------------------------------------------------
async function fetchModels() {
  const tableBody = document.getElementById('models-table-body');
  try {
    const res = await fetch('/api/models');
    if (!res.ok) throw new Error('Failed to fetch registry models');
    const models = await res.json();
    renderModelsTable(models);
  } catch (error) {
    tableBody.innerHTML = `<tr><td colspan="6" class="text-danger text-center">Error: ${error.message}</td></tr>`;
  }
}

function renderModelsTable(models) {
  const tableBody = document.getElementById('models-table-body');
  if (!models || models.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="6" class="table-empty">No active free models in registry. Run a Scan.</td></tr>';
    return;
  }

  const html = models.map(model => {
    const toolsBadge = model.supports_tools 
      ? '<span class="badge-tool-status yes"><i class="ri-checkbox-circle-line"></i> Yes</span>' 
      : '<span class="badge-tool-status no"><i class="ri-close-circle-line"></i> No</span>';
    
    return `
      <tr>
        <td class="model-name-cell">${escapeHTML(model.model_id)}</td>
        <td>${model.context_length.toLocaleString()} tokens</td>
        <td>${toolsBadge}</td>
        <td><i class="ri-speed-up-line text-muted"></i> ${model.latency} ms</td>
        <td>${(model.reliability * 100).toFixed(0)}%</td>
        <td><strong>${model.score.toFixed(2)}</strong></td>
      </tr>
    `;
  }).join('');

  tableBody.innerHTML = html;
}

// ------------------------------------------------------------------------------
// Action Listeners
// ------------------------------------------------------------------------------
function setupActionListeners() {
  // Clear Logs Button
  document.getElementById('btn-clear-logs').addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear system event logs?')) {
      try {
        const res = await fetch('/api/logs/clear', { method: 'POST' });
        if (res.ok) fetchStatusAndLogs();
      } catch (err) {
        console.error('Failed to clear logs:', err);
      }
    }
  });

  // Refresh Logs Button
  document.getElementById('btn-refresh-logs').addEventListener('click', fetchStatusAndLogs);

  // Trigger Model Scan Button
  document.getElementById('btn-trigger-discovery').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> Scanning...';
    
    try {
      const res = await fetch('/api/discover', { method: 'POST' });
      if (res.ok) {
        alert('Model scan started in the background. Check logs for updates.');
        setTimeout(fetchModels, 5000); // Wait 5 seconds and refresh list
      } else {
        alert('Failed to trigger scan.');
      }
    } catch (err) {
      console.error(err);
      alert('Error triggering scan.');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="ri-radar-line"></i> Trigger Model Scan';
    }
  });
}

function fetchInitialData() {
  // Trigger initial loads
  fetchStatusAndLogs();
}

// Helper to escape HTML tags
function escapeHTML(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}
