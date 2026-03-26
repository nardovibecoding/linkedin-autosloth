// Copyright (c) 2026 Nardo. AGPL-3.0 — see LICENSE
// LinkedIn Connection Assistant - Background Service Worker
// Handles state management, timer, and cross-tab communication

class LinkedInAssistantBackground {
  constructor() {
    this.isRunning = false;
    this.currentTabId = null;
    this.automationTimer = null;

    this.init();
  }

  init() {
    // Listen for installation
    chrome.runtime.onInstalled.addListener((details) => {
      if (details.reason === 'install') {
        this.setDefaultSettings();
      }
    });

    // Listen for messages from popup and content scripts
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true;
    });

    // Listen for tab updates
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' && tab.url && tab.url.includes('linkedin.com')) {
        // Tab navigation detected, might need to reset state
      }
    });

    // Listen for tab closure
    chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
      if (tabId === this.currentTabId) {
        this.stop();
      }
    });

    console.log('LinkedIn Assistant Background Service Worker initialized');
  }

  setDefaultSettings() {
    const defaultSettings = {
      template: 'Hi {{firstName}},\n\nI came across your profile and was impressed by your work at {{company}}. I\'d love to connect and learn more about your experience.\n\nBest regards',
      filter1st: false,
      filter2nd: true,
      filter3rd: true,
      enableKeywordFilter: true,
      keywordList: 'Keyword 1, Keyword 2, Keyword 3, Keyword 4',
      dailyLimit: 20,
      minDelay: 30,
      maxDelay: 90
    };

    const defaultStats = {
      sent: 0,
      processed: 0,
      lastResetDate: new Date().toDateString()
    };

    chrome.storage.local.set({
      settings: defaultSettings,
      stats: defaultStats,
      processedProfiles: []
    });

    console.log('Default settings initialized');
  }

  handleMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'start':
        this.start(message.tabId, message.settings);
        sendResponse({ success: true });
        break;

      case 'stop':
        this.stop();
        sendResponse({ success: true });
        break;

      case 'getStatus':
        sendResponse({
          isRunning: this.isRunning,
          tabId: this.currentTabId
        });
        break;

      case 'updateSettings':
        this.updateSettings(message.settings);
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  }

  async start(tabId, settings) {
    if (this.isRunning) {
      console.log('Automation already running');
      return;
    }

    this.isRunning = true;
    this.currentTabId = tabId;

    console.log('Starting automation on tab:', tabId);

    // Send start message to content script
    try {
      await chrome.tabs.sendMessage(tabId, {
        action: 'start',
        settings: settings
      });
    } catch (error) {
      console.error('Error sending start message to content script:', error);
      this.isRunning = false;
      throw error;
    }
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    console.log('Stopping automation');

    this.isRunning = false;

    // Send stop message to content script
    if (this.currentTabId) {
      try {
        await chrome.tabs.sendMessage(this.currentTabId, {
          action: 'stop'
        });
      } catch (error) {
        console.error('Error sending stop message to content script:', error);
      }
    }

    // Clear any pending timers
    if (this.automationTimer) {
      clearTimeout(this.automationTimer);
      this.automationTimer = null;
    }

    this.currentTabId = null;
  }

  async updateSettings(settings) {
    try {
      await chrome.storage.local.set({ settings });
      console.log('Settings updated');
    } catch (error) {
      console.error('Error updating settings:', error);
      throw error;
    }
  }

}

// Initialize background service worker
const backgroundService = new LinkedInAssistantBackground();

// Handle runtime errors
self.onerror = function(message, source, lineno, colno, error) {
  console.error('Background script error:', {
    message,
    source,
    lineno,
    colno,
    error
  });
};

// Handle unhandled promise rejections
self.onunhandledrejection = function(event) {
  console.error('Unhandled promise rejection:', event.reason);
};
