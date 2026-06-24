// Global variables
let activeTab = 'tab-overview';
let userProfiles = [];
let pollingInterval = null;
let flowInterval = null;

// Global Chart Instances
let modelUsageChart = null;
let activityChart = null;
let socialNetwork = null;

// Tab Routing titles
const TAB_TITLES = {
  'tab-overview': { title: 'Dashboard Overview', subtitle: 'System metrics, real-time activity, and performance.' },
  'tab-memory': { title: 'Long-Term Memory Profiles', subtitle: 'Explore and manage cognitive profiles of group members.' },
  'tab-intelligence': { title: 'Social Intelligence', subtitle: 'Analyze user relationships, group vibe, and collective memories.' },
  'tab-router': { title: 'Model Routing Registry', subtitle: 'Dynamic list of discovered free models from OpenRouter.' },
  'tab-dev': { title: 'Developer Control Console', subtitle: 'Execute manual model runs, verify API key pools, run observer digests, and trace active message flows.' }
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
      if (activeTab === 'tab-intelligence') {
        fetchSocialGraph();
        fetchSocialIntelligence();
      }
      if (activeTab === 'tab-router') fetchModels();
      
      // Handle Developer Flow Polling
      if (activeTab === 'tab-dev') {
        fetchKeysStatus();
        fetchFlowTrace();
        if (!flowInterval) {
          flowInterval = setInterval(fetchFlowTrace, 2000);
        }
      } else {
        if (flowInterval) {
          clearInterval(flowInterval);
          flowInterval = null;
        }
      }
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
    const [statusRes, logsRes, usageRes] = await Promise.all([
      fetch('/api/status'),
      fetch('/api/logs'),
      fetch('/api/usage')
    ]);

    if (statusRes.ok) {
      const stats = await statusRes.json();
      updateMetricCards(stats);
    }
    
    if (logsRes.ok) {
      const logs = await logsRes.json();
      renderLogs(logs);
    }

    if (usageRes.ok) {
      const usage = await usageRes.json();
      renderUsageTable(usage);
      updateUsageCharts(usage);
    }
  } catch (error) {
    console.error('Error polling status/logs/usage:', error);
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
  if (stats.stats) {
    document.getElementById('stat-users').textContent = stats.stats.total_users;
  }
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

function renderUsageTable(usage) {
  const tableBody = document.getElementById('usage-table-body');
  if (!tableBody) return;
  if (!usage || usage.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="3" class="table-empty">No requests logged yet today.</td></tr>';
    return;
  }

  const html = usage.map(row => {
    return `
      <tr>
        <td><strong>${escapeHTML(row.usage_date)}</strong></td>
        <td class="model-name-cell">${escapeHTML(row.model_id)}</td>
        <td><strong>${row.request_count}</strong> requests</td>
      </tr>
    `;
  }).join('');

  tableBody.innerHTML = html;
}

// ------------------------------------------------------------------------------
// Charts (Overview)
// ------------------------------------------------------------------------------

function updateUsageCharts(usage) {
  if (!usage || usage.length === 0) return;

  // 1. Model Usage Pie Chart
  const modelCounts = {};
  usage.forEach(row => {
    modelCounts[row.model_id] = (modelCounts[row.model_id] || 0) + row.request_count;
  });

  const modelLabels = Object.keys(modelCounts);
  const modelData = Object.values(modelCounts);

  const ctxModel = document.getElementById('modelUsageChart');
  if (ctxModel) {
    if (modelUsageChart) {
      modelUsageChart.data.labels = modelLabels;
      modelUsageChart.data.datasets[0].data = modelData;
      modelUsageChart.update();
    } else {
      modelUsageChart = new Chart(ctxModel, {
        type: 'doughnut',
        data: {
          labels: modelLabels,
          datasets: [{
            data: modelData,
            backgroundColor: [
              '#8a2be2', '#4169e1', '#2e8b57', '#d2691e', '#dc143c', '#00ffff'
            ],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'right', labels: { color: '#cbd5e1', font: { family: 'Outfit' } } }
          }
        }
      });
    }
  }

  // 2. Activity Line Chart (Last 7 Days)
  const dateCounts = {};
  usage.forEach(row => {
    dateCounts[row.usage_date] = (dateCounts[row.usage_date] || 0) + row.request_count;
  });

  const dates = Object.keys(dateCounts).sort().slice(-7);
  const activityData = dates.map(d => dateCounts[d]);

  const ctxActivity = document.getElementById('activityChart');
  if (ctxActivity) {
    if (activityChart) {
      activityChart.data.labels = dates;
      activityChart.data.datasets[0].data = activityData;
      activityChart.update();
    } else {
      activityChart = new Chart(ctxActivity, {
        type: 'line',
        data: {
          labels: dates,
          datasets: [{
            label: 'Requests',
            data: activityData,
            borderColor: '#8a2be2',
            backgroundColor: 'rgba(138, 43, 226, 0.1)',
            fill: true,
            tension: 0.4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b' } },
            x: { grid: { display: false }, ticks: { color: '#64748b' } }
          },
          plugins: {
            legend: { display: false }
          }
        }
      });
    }
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
// Social Intelligence & Graph
// ------------------------------------------------------------------------------

async function fetchSocialGraph() {
  const container = document.getElementById('social-graph-container');
  if (!container) return;

  try {
    const res = await fetch('/api/social/graph');
    const data = await res.json();
    renderSocialGraph(data);
  } catch (error) {
    console.error('Failed to fetch social graph:', error);
  }
}

function renderSocialGraph(data) {
  const container = document.getElementById('social-graph-container');
  const { links, users } = data;

  const nodes = new vis.DataSet(users.map(u => ({
    id: u.user_id,
    label: u.name,
    shape: 'circularImage',
    image: `https://ui-avatars.com/api/?name=${encodeURIComponent(u.name)}&background=8a2be2&color=fff`,
    color: { border: '#8a2be2', background: '#0f101d' },
    font: { color: '#cbd5e1', face: 'Outfit' }
  })));

  const edges = new vis.DataSet(links.map(l => ({
    from: l.user_a_id,
    to: l.user_b_id,
    label: l.relation_type,
    font: { align: 'top', color: '#64748b', size: 10 },
    color: { color: 'rgba(138, 43, 226, 0.3)', hover: '#8a2be2' }
  })));

  const options = {
    nodes: { borderWidth: 2, size: 30 },
    edges: { width: 2, selectionWidth: 4 },
    physics: {
      forceAtlas2Based: { gravitationalConstant: -50, centralGravity: 0.01, springLength: 100, springConstant: 0.08 },
      maxVelocity: 50,
      solver: 'forceAtlas2Based',
      timestep: 0.35,
      stabilization: { iterations: 150 }
    },
    interaction: { hover: true, tooltipDelay: 200 }
  };

  if (socialNetwork) socialNetwork.destroy();
  socialNetwork = new vis.Network(container, { nodes, edges }, options);
}

async function fetchSocialIntelligence() {
  try {
    const res = await fetch('/api/social/intelligence');
    const data = await res.json();
    renderSocialIntelligence(data);
  } catch (error) {
    console.error('Failed to fetch social intelligence:', error);
  }
}

function renderSocialIntelligence(data) {
  const vibeVal = document.querySelector('.vibe-value');
  const vibeMeta = document.querySelector('.vibe-meta');
  const memoriesList = document.getElementById('collective-memories-list');

  if (vibeVal) vibeVal.textContent = data.vibe || 'Neutral';
  if (vibeMeta) vibeMeta.textContent = `Last analyzed: ${new Date().toLocaleTimeString()}`;

  if (memoriesList) {
    if (!data.memories || data.memories.length === 0) {
      memoriesList.innerHTML = '<li class="empty-list">No collective memories recorded yet.</li>';
    } else {
      memoriesList.innerHTML = data.memories.map(m => `
        <li>${escapeHTML(m.event_description)}</li>
      `).join('');
    }
  }
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

  // Refresh Usage Button
  const btnRefreshUsage = document.getElementById('btn-refresh-usage');
  if (btnRefreshUsage) {
    btnRefreshUsage.addEventListener('click', fetchStatusAndLogs);
  }

  // Refresh Graph Button
  const btnRefreshGraph = document.getElementById('btn-refresh-graph');
  if (btnRefreshGraph) {
    btnRefreshGraph.addEventListener('click', fetchSocialGraph);
  }

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

  // ----------------------------------------------------------------------------
  // Dev Tab Actions
  // ----------------------------------------------------------------------------

  // Manual Model Call Sandbox Submit
  const formTestModel = document.getElementById('form-test-model');
  if (formTestModel) {
    formTestModel.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn-test-model');
      const resultBox = document.getElementById('sandbox-model-result');
      
      const tier = document.getElementById('sandbox-tier').value;
      const model = document.getElementById('sandbox-model').value;
      const prompt = document.getElementById('sandbox-prompt').value;
      const systemInstruction = document.getElementById('sandbox-system').value;
      
      if (!tier && !model) {
        alert('Please select either a Routing Tier or a Direct Model ID.');
        return;
      }
      
      btn.disabled = true;
      btn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> Executing...';
      resultBox.innerHTML = '<div class="loader">Querying model endpoint, please wait...</div>';
      
      try {
        const res = await fetch('/api/dev/test-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tier, model, prompt, systemInstruction })
        });
        
        const data = await res.json();
        
        if (res.ok && data.success) {
          // Render plain text output
          resultBox.textContent = data.reply;
        } else {
          resultBox.innerHTML = `<span class="text-danger">Error: ${data.error || 'Execution failed.'}</span>`;
        }
      } catch (err) {
        resultBox.innerHTML = `<span class="text-danger">Request Failed: ${err.message}</span>`;
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="ri-play-line"></i> Run Model Call';
        fetchKeysStatus();
        fetchFlowTrace();
      }
    });
  }

  // Manual Tool sandbox executor submit
  const formTestTool = document.getElementById('form-test-tool');
  if (formTestTool) {
    formTestTool.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn-test-tool');
      const resultBox = document.getElementById('sandbox-tool-result');
      
      const toolName = document.getElementById('sandbox-tool-select').value;
      const arg = document.getElementById('sandbox-tool-arg').value;
      
      btn.disabled = true;
      btn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> Executing Tool...';
      resultBox.innerHTML = '<div class="loader">Running tool call in sandbox...</div>';
      
      try {
        const res = await fetch('/api/dev/test-tool', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolName, args: [arg] })
        });
        
        const data = await res.json();
        
        if (res.ok && data.success) {
          const out = data.result;
          resultBox.innerHTML = `<pre><code>${JSON.stringify(out, null, 2)}</code></pre>`;
        } else {
          resultBox.innerHTML = `<span class="text-danger">Error: ${data.error || 'Tool call failed.'}</span>`;
        }
      } catch (err) {
        resultBox.innerHTML = `<span class="text-danger">Request Failed: ${err.message}</span>`;
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="ri-play-line"></i> Run Tool Call';
        fetchFlowTrace();
      }
    });
  }

  // Trigger Observer sweep manually
  const btnTriggerDigest = document.getElementById('btn-trigger-digest');
  if (btnTriggerDigest) {
    btnTriggerDigest.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> Observing...';
      
      try {
        const res = await fetch('/api/dev/trigger-digest', { method: 'POST' });
        if (res.ok) {
          alert('Passive Observer Sweep triggered in the background. Check logs console.');
        } else {
          alert('Failed to trigger Observer sweep.');
        }
      } catch (err) {
        console.error(err);
        alert('Error triggering sweep.');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="ri-radar-line"></i> Execute Observer Sweep';
      }
    });
  }

  // Refresh flow button click
  const btnRefreshFlow = document.getElementById('btn-refresh-flow');
  if (btnRefreshFlow) {
    btnRefreshFlow.addEventListener('click', fetchFlowTrace);
  }
}

function fetchInitialData() {
  fetchStatusAndLogs();
}

// ------------------------------------------------------------------------------
// Dev Console Fetch & Renders
// ------------------------------------------------------------------------------

async function fetchKeysStatus() {
  const container = document.getElementById('keys-status-grid');
  if (!container) return;
  
  try {
    const res = await fetch('/api/dev/keys-status');
    if (!res.ok) throw new Error('Failed to load key statuses');
    const data = await res.json();
    
    let html = '';
    const renderCard = (key, type) => {
      const typeBadge = type === 'active' ? 'badge-skill' : 'badge-interest';
      const statusClass = key.status === 'HEALTHY' ? 'text-success' : (key.status === 'ERROR' ? 'text-danger' : 'text-muted');
      
      return `
        <div class="key-status-card">
          <div class="key-status-header">
            <h4>${key.name}</h4>
            <span class="badge ${typeBadge}">${type.toUpperCase()}</span>
          </div>
          <div class="key-status-details">
            <p>Configured: <strong>${key.configured ? '✅ Yes' : '❌ No'}</strong></p>
            <p>Pool Status: <span class="${statusClass}"><strong>${key.status}</strong></span></p>
            <p>Error Count: <code>${key.errorCount}</code></p>
            <p>Last Used: <small>${key.lastUsed}</small></p>
          </div>
        </div>
      `;
    };
    
    data.active.forEach(k => { html += renderCard(k, 'active'); });
    data.backup.forEach(k => { html += renderCard(k, 'backup'); });
    
    container.innerHTML = html;
  } catch (error) {
    container.innerHTML = `<div class="text-danger text-center w-full">Error: ${error.message}</div>`;
  }
}

async function fetchFlowTrace() {
  const treeContainer = document.getElementById('flow-tree-container');
  if (!treeContainer) return;
  
  try {
    const res = await fetch('/api/dev/active-flow');
    if (!res.ok) throw new Error('Failed to fetch trace');
    const trace = await res.json();
    
    renderFlowTree(trace);
  } catch (error) {
    console.error('Error fetching flow:', error);
  }
}

function renderFlowTree(trace) {
  const treeContainer = document.getElementById('flow-tree-container');
  const userTag = document.getElementById('flow-user-tag');
  const msgText = document.getElementById('flow-msg-text');
  
  if (!trace || !trace.steps || trace.steps.length === 0) {
    userTag.textContent = 'No message active';
    msgText.textContent = 'Awaiting message triggers... send a message on Telegram or use the sandbox model tester below.';
    treeContainer.innerHTML = `
      <div class="flow-step empty">
        <div class="flow-step-dot"></div>
        <div class="flow-step-content">
          <h4>No active trace loaded</h4>
          <p>Send a message on Telegram or execute the Model Tester below to see the trace tree diagram.</p>
        </div>
      </div>
    `;
    return;
  }
  
  userTag.textContent = `@${trace.user || 'User'}`;
  msgText.textContent = `"${trace.message || ''}"`;
  
  const iconMap = {
    'RECEIVE': 'ri-chat-download-line',
    'CLASSIFY': 'ri-filter-line',
    'PLANNER': 'ri-brain-line',
    'TOOL': 'ri-tools-line',
    'SYNTHESIS': 'ri-edit-box-line',
    'ROUTER': 'ri-route-line',
    'DISCOVERY': 'ri-radar-line',
    'OBSERVER': 'ri-bubble-chart-line'
  };
  
  const html = trace.steps.map(step => {
    const icon = iconMap[step.stage] || 'ri-checkbox-blank-circle-line';
    const statusClass = step.status; // success, failed, pending
    const time = new Date(step.timestamp).toLocaleTimeString();
    
    return `
      <div class="flow-step step-${statusClass}">
        <div class="flow-step-dot ${statusClass}">
          <i class="${icon} ${statusClass === 'pending' ? 'ri-spin' : ''}"></i>
        </div>
        <div class="flow-step-content">
          <div class="flow-step-header">
            <h4>${step.stage}</h4>
            <span class="step-time">[${time}]</span>
          </div>
          <p>${escapeHTML(step.details)}</p>
        </div>
      </div>
    `;
  }).join('');
  
  treeContainer.innerHTML = html;
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
