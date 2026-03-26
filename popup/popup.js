// LinkedIn Connection Assistant - Popup Script (v5)

class LinkedInAssistantPopup {
  constructor() {
    this.isRunning = false;
    this.isDmRunning = false;
    this.activeKeyword = null;
    this.envStatus = null;
    this.settings = {
      template: `Your Add A Note Text`,
      dmReplyTemplate: '',
      dailyLimit: 40,
      minDelay: 3,
      maxDelay: 5
    };
    this.stats = {
      sent: 0,
      processed: 0,
      dmReplied: 0,
      lastResetDate: null
    };

    this.init();
  }

  async init() {
    await this.loadSettings();
    await this.loadStats();
    await this.loadRunningState();
    this.setupEventListeners();
    
    // Force update settings to new defaults
    const newTemplate = `Your Add A Note Text`;

    const newDmTemplate = `Your Reply Text`;
    
    this.settings.template = newTemplate;
    this.settings.dmReplyTemplate = newDmTemplate;
    this.settings.minDelay = 2;
    this.settings.maxDelay = 3;
    this.settings.dailyLimit = 40;
    await this.saveSettings();
    
    this.updateUI();
    
    // Load environment status
    await this.loadEnvStatus();
  }

  async loadEnvStatus() {
    try {
      // First try to get cached env status
      const result = await chrome.storage.local.get(['envStatus']);
      if (result.envStatus) {
        this.envStatus = result.envStatus;
        this.updateEnvUI();
      }
      
      // Then request fresh detection from content script
      await this.refreshEnvDetection();
    } catch (e) {
      console.log('Could not load env status:', e);
    }
  }

  async refreshEnvDetection() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab || !tab.url || !tab.url.includes('linkedin.com')) {
        this.updateEnvSummary('Not on LinkedIn - navigate to linkedin.com first', 'warning');
        return;
      }

      // Request fresh environment detection
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getEnvStatus' });
      
      if (response && response.envStatus) {
        this.envStatus = response.envStatus;
        this.updateEnvUI();
      }
    } catch (e) {
      // Content script might not be loaded
      this.updateEnvSummary('Content script not loaded - refresh the LinkedIn page', 'warning');
    }
  }

  updateEnvUI() {
    if (!this.envStatus) return;

    const env = this.envStatus;
    let score = 0;
    let statusText = '';
    let statusType = 'good';

    const onLinkedIn = env.linkedInNavbar;
    const onSearch = env.searchResultsContainer;
    const onMessaging = env.messagingContainer;

    if (!onLinkedIn) {
      // Not on LinkedIn at all
      score = 0;
      statusText = 'Not on LinkedIn — navigate to linkedin.com first';
      statusType = 'warning';
    } else if (onSearch) {
      // On search results page — check connect-related selectors
      score = 50; // Base for being on search page
      if (env.profileCards > 0) score += 25;
      if (env.connectButtons > 0) score += 25;

      if (score >= 90) {
        statusText = `✓ Search page ready — ${env.profileCards} profiles, ${env.connectButtons} connect buttons`;
      } else if (score >= 50) {
        const missing = [];
        if (!env.profileCards) missing.push('no profile cards');
        if (!env.connectButtons) missing.push('no connect buttons');
        statusText = `⚠ Search page loaded but ${missing.join(', ')} — try scrolling or different search`;
        statusType = 'warning';
      }
    } else if (onMessaging) {
      // On messaging page — check DM-related selectors
      score = 40; // Base for being on messaging page
      if (env.conversationItems > 0) score += 20;
      if (env.messageInput) score += 20;
      if (env.sendButton) score += 20;

      if (score >= 80) {
        statusText = `✓ Messaging ready — ${env.conversationItems} conversations loaded`;
      } else if (score >= 40) {
        const missing = [];
        if (!env.conversationItems) missing.push('no conversations');
        if (!env.messageInput) missing.push('no message input');
        if (!env.sendButton) missing.push('no send button');
        statusText = `⚠ Messaging loaded but ${missing.join(', ')} — click on a conversation`;
        statusType = 'warning';
      }
    } else {
      // On LinkedIn but not on a functional page (home feed, profile, etc.)
      // This is totally normal — tool is fine, just navigate
      score = 75;
      statusText = '✓ LinkedIn detected — go to Search or Messaging to start';
      statusType = 'good';
    }

    // Update UI
    const fill = document.getElementById('envHealthFill');
    const scoreEl = document.getElementById('envHealthScore');
    const textEl = document.querySelector('#envHealthStatus .env-health-text');

    fill.style.width = `${score}%`;
    fill.classList.remove('good', 'warning', 'bad');
    scoreEl.textContent = score;

    if (score >= 70) {
      fill.classList.add('good');
      scoreEl.style.color = '#16a34a';
      textEl.className = 'env-health-text status-good';
    } else if (score >= 40) {
      fill.classList.add('warning');
      scoreEl.style.color = '#d97706';
      textEl.className = 'env-health-text status-warning';
    } else {
      fill.classList.add('bad');
      scoreEl.style.color = '#dc2626';
      textEl.className = 'env-health-text status-bad';
    }

    textEl.textContent = statusText;
  }

  updateEnvSummary(text, type) {
    const textEl = document.querySelector('#envHealthStatus .env-health-text');
    if (!textEl) return;
    textEl.textContent = text;
    textEl.className = 'env-health-text';
    if (type === 'warning') textEl.classList.add('status-warning');
    else if (type === 'error') textEl.classList.add('status-bad');
  }

  async loadRunningState() {
    try {
      const result = await chrome.storage.local.get(['automationState', 'dmAutomationState']);
      
      if (result.automationState && result.automationState.isRunning) {
        this.isRunning = true;
        this.activeKeyword = result.automationState.keywords?.[0] || null;
        
        if (this.activeKeyword) {
          document.querySelectorAll('.search-keyword-btn').forEach(btn => {
            if (btn.dataset.keyword === this.activeKeyword) {
              btn.classList.add('active');
            }
          });
        }
      } else {
        this.isRunning = false;
      }

      if (result.dmAutomationState && result.dmAutomationState.isRunning) {
        this.isDmRunning = true;
      } else {
        this.isDmRunning = false;
      }
    } catch (error) {
      console.error('Error loading running state:', error);
      this.isRunning = false;
      this.isDmRunning = false;
    }
  }

  async loadSettings() {
    try {
      const result = await chrome.storage.local.get(['settings', 'stats']);

      if (result.settings) {
        this.settings = { ...this.settings, ...result.settings };
      }

      if (result.stats) {
        this.stats = { ...this.stats, ...result.stats };
      }

      const today = new Date().toDateString();
      if (this.stats.lastResetDate !== today) {
        this.stats.sent = 0;
        this.stats.lastResetDate = today;
        await this.saveStats();
      }
    } catch (error) {
      this.log('Error loading settings: ' + error.message, 'error');
    }
  }

  async saveSettings() {
    try {
      await chrome.storage.local.set({ settings: this.settings });
    } catch (error) {
      this.log('Error saving settings: ' + error.message, 'error');
    }
  }

  async saveStats() {
    try {
      await chrome.storage.local.set({ stats: this.stats });
    } catch (error) {
      this.log('Error saving stats: ' + error.message, 'error');
    }
  }

  setupEventListeners() {
    // Template textarea
    const templateTextarea = document.getElementById('messageTemplate');
    templateTextarea.value = this.settings.template;
    templateTextarea.addEventListener('input', (e) => {
      this.settings.template = e.target.value;
      this.updateCharCount();
      this.saveSettings();
    });

    // DM Reply Template textarea
    const dmTemplateTextarea = document.getElementById('dmReplyTemplate');
    dmTemplateTextarea.value = this.settings.dmReplyTemplate || '';
    dmTemplateTextarea.addEventListener('input', (e) => {
      this.settings.dmReplyTemplate = e.target.value;
      this.updateDmCharCount();
      this.saveSettings();
    });

    // Variable pills for connection message
    document.querySelectorAll('.variable-pill:not(.dm-pill)').forEach(pill => {
      pill.addEventListener('click', () => {
        this.insertVariable(pill.dataset.var, 'messageTemplate');
      });
    });

    // Variable pills for DM reply
    document.querySelectorAll('.variable-pill.dm-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        this.insertVariable(pill.dataset.var, 'dmReplyTemplate');
      });
    });

    // Auto Reply DMs button
    document.getElementById('autoReplyBtn').addEventListener('click', () => {
      this.toggleDmReply();
    });

    // Check Current Conversation button
    document.getElementById('checkCurrentBtn').addEventListener('click', () => {
      this.checkCurrentConversation();
    });

    // Refresh environment detection button
    document.getElementById('refreshEnvBtn').addEventListener('click', () => {
      this.log('Refreshing environment detection...', 'info');
      this.refreshEnvDetection();
    });

    // Quick search keyword buttons
    document.querySelectorAll('.search-keyword-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.searchAndConnect(btn.dataset.keyword);
      });
    });

    // Custom search button
    document.getElementById('searchCustomBtn').addEventListener('click', () => {
      const keyword = document.getElementById('customKeyword').value.trim();
      if (keyword) {
        this.searchAndConnect(keyword);
      } else {
        this.log('Please enter a keyword', 'warning');
      }
    });

    // Custom search on Enter key
    document.getElementById('customKeyword').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const keyword = e.target.value.trim();
        if (keyword) {
          this.searchAndConnect(keyword);
        }
      }
    });

    // Safety controls
    document.getElementById('dailyLimit').value = this.settings.dailyLimit;
    document.getElementById('minDelay').value = this.settings.minDelay;
    document.getElementById('maxDelay').value = this.settings.maxDelay;

    ['dailyLimit', 'minDelay', 'maxDelay'].forEach(id => {
      document.getElementById(id).addEventListener('change', (e) => {
        this.settings[id] = parseInt(e.target.value) || 20;
        this.saveSettings();
        this.updateUI();
      });
    });

    // Toggle button
    document.getElementById('toggleBtn').addEventListener('click', () => {
      this.toggleAutomation();
    });

    // Reset button
    document.getElementById('resetBtn').addEventListener('click', () => {
      this.resetCounter();
    });

    // Clear log button
    document.getElementById('clearLogBtn').addEventListener('click', () => {
      this.clearLog();
    });

    this.updateCharCount();
    this.updateDmCharCount();
  }

  async searchAndConnect(keyword) {
    if (this.stats.sent >= this.settings.dailyLimit) {
      this.log('Daily limit reached!', 'warning');
      return;
    }

    this.activeKeyword = keyword;
    document.querySelectorAll('.search-keyword-btn').forEach(btn => {
      btn.classList.remove('active');
      if (btn.dataset.keyword === keyword) {
        btn.classList.add('active');
      }
    });

    this.log(`Searching for "${keyword}"...`, 'info');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      this.log('No active tab found', 'error');
      return;
    }

    await chrome.storage.local.set({
      automationState: {
        isRunning: true,
        settings: this.settings,
        keywords: [keyword],
        currentKeywordIndex: 0
      }
    });

    this.isRunning = true;
    this.updateUI();

    const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keyword)}&origin=GLOBAL_SEARCH_HEADER`;

    await chrome.tabs.update(tab.id, { url: searchUrl });
    
    this.log(`✓ Auto-connecting to "${keyword}" results...`, 'success');
  }

  insertVariable(variable, textareaId = 'messageTemplate') {
    const textarea = document.getElementById(textareaId);
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const variableText = `{{${variable}}}`;

    textarea.value = text.substring(0, start) + variableText + text.substring(end);
    
    if (textareaId === 'messageTemplate') {
      this.settings.template = textarea.value;
      this.updateCharCount();
    } else if (textareaId === 'dmReplyTemplate') {
      this.settings.dmReplyTemplate = textarea.value;
      this.updateDmCharCount();
    }
    
    textarea.focus();
    textarea.setSelectionRange(start + variableText.length, start + variableText.length);
    this.saveSettings();
  }

  updateCharCount() {
    const template = document.getElementById('messageTemplate').value;
    document.getElementById('charCount').textContent = `${template.length} / 300`;
  }

  updateDmCharCount() {
    const template = document.getElementById('dmReplyTemplate').value;
    document.getElementById('dmCharCount').textContent = `${template.length} / 500`;
  }

  async toggleAutomation() {
    if (this.isRunning) {
      await this.stopAutomation();
    } else {
      await this.startAutomation();
    }
  }

  async ensureContentScript(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      if (response && response.alive) {
        return true;
      }
    } catch (e) {}

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content/content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tabId },
        files: ['content/content.css']
      });
    } catch (e) {
      this.log('Injection error: ' + e.message, 'error');
      return false;
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    try {
      const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      if (response && response.alive) {
        return true;
      }
    } catch (e) {
      return false;
    }

    return false;
  }

  async startAutomation() {
    if (this.stats.sent >= this.settings.dailyLimit) {
      this.log('Daily limit reached. Please reset or wait for tomorrow.', 'warning');
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || !tab.url.includes('linkedin.com')) {
      this.log('Please navigate to a LinkedIn page first.', 'warning');
      return;
    }

    // Collect all keywords from the keyword buttons
    const allKeywords = [];
    document.querySelectorAll('.search-keyword-btn').forEach(btn => {
      if (btn.dataset.keyword) allKeywords.push(btn.dataset.keyword);
    });

    // Also include custom keyword if typed
    const customKw = document.getElementById('customKeyword').value.trim();
    if (customKw && !allKeywords.includes(customKw)) {
      allKeywords.unshift(customKw); // Put custom keyword first
    }

    if (!allKeywords.length) {
      this.log('No keywords available.', 'warning');
      return;
    }

    this.log(`Starting automation with ${allKeywords.length} keywords: ${allKeywords.slice(0, 3).join(', ')}...`, 'info');

    // Save state and navigate — same flow as searchAndConnect
    await chrome.storage.local.set({
      automationState: {
        isRunning: true,
        settings: this.settings,
        keywords: allKeywords,
        currentKeywordIndex: 0
      }
    });

    this.isRunning = true;
    this.activeKeyword = allKeywords[0];
    this.updateUI();

    const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(allKeywords[0])}&origin=GLOBAL_SEARCH_HEADER`;
    await chrome.tabs.update(tab.id, { url: searchUrl });

    this.log(`✓ Searching for "${allKeywords[0]}"...`, 'success');
  }

  async stopAutomation() {
    this.isRunning = false;
    this.activeKeyword = null;

    document.querySelectorAll('.search-keyword-btn').forEach(btn => {
      btn.classList.remove('active');
    });

    await chrome.storage.local.set({
      automationState: {
        isRunning: false,
        settings: null,
        keywords: [],
        currentKeywordIndex: 0
      }
    });

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, { action: 'stop' });
      }
      this.log('Automation stopped.', 'info');
    } catch (error) {
      this.log('Stopped.', 'info');
    }

    this.updateUI();
  }

  async toggleDmReply() {
    if (this.isDmRunning) {
      await this.stopDmReply();
    } else {
      await this.startDmReply();
    }
  }

  async checkCurrentConversation() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || !tab.url.includes('linkedin.com/messaging')) {
      this.log('Please open a LinkedIn conversation first', 'warning');
      return;
    }

    if (!this.settings.dmReplyTemplate || !this.settings.dmReplyTemplate.trim()) {
      this.log('Please enter a DM reply template first.', 'warning');
      return;
    }

    this.log('Starting DM loop from current conversation...', 'info');

    try {
      // Save DM automation state
      await chrome.storage.local.set({
        dmAutomationState: {
          isRunning: true,
          settings: this.settings
        }
      });

      this.isDmRunning = true;
      this.updateUI();

      // Tell content script to mark all conversations ABOVE the currently
      // selected one as "already processed", then start the normal DM loop
      // which applies the same rules (blue dot → reply, ≥7d → follow up)
      await chrome.tabs.sendMessage(tab.id, {
        action: 'startDmFromCurrent',
        settings: this.settings
      });

    } catch (error) {
      this.log('Error: ' + error.message, 'error');
    }
  }

  async startDmReply() {
    if (this.isRunning) {
      await this.stopAutomation();
    }

    if (!this.settings.dmReplyTemplate || !this.settings.dmReplyTemplate.trim()) {
      this.log('Please enter a DM reply template first.', 'warning');
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      this.log('No active tab found', 'error');
      return;
    }

    this.log('Starting Auto Reply DMs...', 'info');

    await chrome.storage.local.set({
      dmAutomationState: {
        isRunning: true,
        settings: this.settings
      }
    });

    const inboxUrl = 'https://www.linkedin.com/messaging/';
    
    this.isDmRunning = true;
    this.updateUI();
    
    await chrome.tabs.update(tab.id, { url: inboxUrl });
    this.log('Navigating to inbox...', 'info');
  }

  async stopDmReply() {
    this.isDmRunning = false;

    await chrome.storage.local.set({
      dmAutomationState: {
        isRunning: false,
        settings: null
      }
    });

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, { action: 'stopDm' });
      }
      this.log('DM Reply stopped.', 'info');
    } catch (error) {
      this.log('DM Reply stopped.', 'info');
    }

    this.updateUI();
  }

  async resetCounter() {
    this.stats.sent = 0;
    this.stats.processed = 0;
    this.stats.dmReplied = 0;
    await this.saveStats();
    
    // Also clear replied conversations to allow re-checking
    await chrome.storage.local.set({ repliedConversations: [] });
    
    this.updateUI();
    this.log('Counter and DM history have been reset.', 'info');
  }

  clearLog() {
    const logEntries = document.getElementById('logEntries');
    logEntries.innerHTML = '<div class="log-entry log-info">Log cleared</div>';
  }

  log(message, type = 'info') {
    const logEntries = document.getElementById('logEntries');
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    entry.innerHTML = `<span>[${timestamp}]</span> ${message}`;

    logEntries.appendChild(entry);
    logEntries.scrollTop = logEntries.scrollHeight;
  }

  updateUI() {
    const toggleBtn = document.getElementById('toggleBtn');
    const statusIndicator = document.getElementById('statusIndicator');
    const statusText = document.getElementById('statusText');
    const autoReplyBtn = document.getElementById('autoReplyBtn');

    if (this.isRunning) {
      toggleBtn.classList.add('running');
      toggleBtn.querySelector('.btn-icon').textContent = '■';
      toggleBtn.querySelector('.btn-text').textContent = 'Stop';
      statusIndicator.className = 'status-indicator running';
      statusText.textContent = 'Running';
    } else {
      toggleBtn.classList.remove('running');
      toggleBtn.querySelector('.btn-icon').textContent = '▶';
      toggleBtn.querySelector('.btn-text').textContent = 'Run All Keywords';
      statusIndicator.className = 'status-indicator stopped';
      statusText.textContent = 'Idle';
    }

    if (this.isDmRunning) {
      autoReplyBtn.classList.add('running');
      autoReplyBtn.querySelector('.btn-icon').textContent = '■';
      autoReplyBtn.querySelector('.btn-text').textContent = 'Stop DM Reply';
      statusIndicator.className = 'status-indicator running';
      statusText.textContent = 'Replying DMs';
    } else {
      autoReplyBtn.classList.remove('running');
      autoReplyBtn.querySelector('.btn-icon').textContent = '💬';
      autoReplyBtn.querySelector('.btn-text').textContent = 'Auto Reply All DMs';
    }

    document.getElementById('sentCount').textContent = this.stats.sent;
    document.getElementById('limitCount').textContent = this.settings.dailyLimit;
    document.getElementById('processedCount').textContent = this.stats.processed;
    document.getElementById('dmRepliedCount').textContent = this.stats.dmReplied || 0;
  }

  async loadStats() {
    try {
      const result = await chrome.storage.local.get(['stats']);
      if (result.stats) {
        this.stats = { ...this.stats, ...result.stats };
      }
    } catch (error) {
      console.error('Error loading stats:', error);
    }
  }
}

function adjustNumber(id, delta) {
  const input = document.getElementById(id);
  let value = parseInt(input.value) || 20;
  let newValue = value + delta;

  const min = parseInt(input.min) || 1;
  const max = parseInt(input.max) || 999;

  if (newValue >= min && newValue <= max) {
    input.value = newValue;
    input.dispatchEvent(new Event('change'));
  }
}

// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
  window.popup = new LinkedInAssistantPopup();

  // Listen for messages from content script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'statsUpdate') {
      window.popup.stats = message.stats;
      window.popup.updateUI();
    }
    if (message.type === 'log') {
      window.popup.log(message.message, message.logType);
    }
    if (message.type === 'stopped') {
      window.popup.isRunning = false;
      window.popup.updateUI();
    }
    if (message.type === 'envUpdate') {
      window.popup.envStatus = message.envStatus;
      window.popup.updateEnvUI();
    }
  });
});
