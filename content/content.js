// LinkedIn Connection Assistant - Content Script (v7)
// DM Rules (mutually exclusive):
//   Rule 1: Blue dot / unread indicator on conversation → REPLY
//   Rule 2: No blue dot → check sidebar timestamp. ≥7 days → REPLY. <7 days → SKIP.
// All decisions from sidebar. Opens convo only to type + send.

(function () {
  if (window.__linkedinAssistantInstance) {
    console.log('[LI-Assist] Already initialized, skipping duplicate');
    return;
  }

  class LinkedInContentScript {
    constructor() {
      this.isRunning = false;
      this.isDmRunning = false;
      this.settings = null;
      this.stats = { sent: 0, processed: 0, dmReplied: 0, lastResetDate: null };
      this.processedProfiles = new Set();
      this.repliedConversations = new Set(); // Reset each DM run
      this.sentMessages = new Map();

      this.keywords = [];
      this.currentKeywordIndex = 0;
      this.envStatus = {};

      this.init();
    }

    async init() {
      await this.loadData();
      this.listenForMessages();
      console.log('[LI-Assist] v7 Initialized on:', window.location.href);

      await this.detectEnvironment();

      // Resume DM automation if it was running
      const dmState = await this.getStorageValue('dmAutomationState');
      if (dmState && dmState.isRunning) {
        console.log('[LI-Assist] Resuming DM reply automation...');
        this.log('Resuming DM automation...', 'info');
        this.isDmRunning = true;
        this.settings = dmState.settings;

        // IMPORTANT: Do NOT restore repliedConversations from storage here
        // We start fresh each run so we actually process conversations
        this.repliedConversations = new Set();

        await this.sleep(2500);
        await this.runDmAutomation();
        return;
      }

      // Resume connection automation
      const connState = await this.getStorageValue('automationState');
      if (connState && connState.isRunning) {
        this.log('Resumed connection automation...', 'info');
        this.isRunning = true;
        this.settings = connState.settings;
        this.keywords = connState.keywords || [];
        this.currentKeywordIndex = connState.currentKeywordIndex || 0;

        // Small delay to ensure page is ready (v3 approach - works reliably)
        await this.sleep(2000);
        await this.processNextProfile();
      }
    }

    // ─── Environment Detection ────────────────────────────────────────────────

    async detectEnvironment() {
      this.envStatus = {
        searchResultsContainer: !!document.querySelector('.search-results-container'),
        profileCards: document.querySelectorAll('li.reusable-search__result-container').length,
        connectButtons: document.querySelectorAll('button[aria-label*="Connect"], button[aria-label*="Invite"]').length,
        messagingContainer: !!document.querySelector('.msg-conversations-container, .messaging-container'),
        conversationList: !!document.querySelector('.msg-conversations-container__conversations-list, .msg__list'),
        conversationItems: document.querySelectorAll('li.msg-conversation-listitem').length,
        messageInput: !!this.findMessageInput(),
        sendButton: !!this.findSendButton(),
        messageThread: !!document.querySelector('.msg-s-message-list'),
        messageItems: document.querySelectorAll('.msg-s-event-listitem').length,
        profileHeader: !!document.querySelector('.scaffold-layout__main, .pv-top-card'),
        linkedInNavbar: !!document.querySelector('#global-nav, .global-nav'),
      };

      await this.setStorageValue('envStatus', this.envStatus);
      console.log('[LI-Assist] Environment:', this.envStatus);

      try {
        chrome.runtime.sendMessage({ type: 'envUpdate', envStatus: this.envStatus });
      } catch (e) {}
    }

    // ─── Storage helpers ──────────────────────────────────────────────────────

    getStorageValue(key) {
      return new Promise(resolve => {
        chrome.storage.local.get([key], result => resolve(result[key] || null));
      });
    }

    setStorageValue(key, value) {
      return new Promise(resolve => {
        chrome.storage.local.set({ [key]: value }, resolve);
      });
    }

    async loadData() {
      try {
        const result = await new Promise(resolve =>
          chrome.storage.local.get(['settings', 'stats', 'processedProfiles', 'sentMessages'], resolve)
        );
        if (result.settings) this.settings = result.settings;
        if (result.stats) this.stats = { ...this.stats, ...result.stats };
        if (result.processedProfiles) this.processedProfiles = new Set(result.processedProfiles);
        if (result.sentMessages) this.sentMessages = new Map(Object.entries(result.sentMessages));

        const today = new Date().toDateString();
        if (this.stats.lastResetDate !== today) {
          this.stats = { sent: 0, processed: 0, dmReplied: 0, lastResetDate: today };
          this.processedProfiles = new Set();
          await this.saveData();
        }
      } catch (e) {
        console.error('[LI-Assist] loadData error:', e);
      }
    }

    async saveData() {
      await chrome.storage.local.set({
        stats: this.stats,
        processedProfiles: Array.from(this.processedProfiles),
        sentMessages: Object.fromEntries(this.sentMessages)
      });
    }

    async saveRepliedConversations() {
      await this.setStorageValue('repliedConversations', Array.from(this.repliedConversations));
    }

    async clearDmAutomationState() {
      await this.setStorageValue('dmAutomationState', { isRunning: false, settings: null });
    }

    // ─── Message listener ─────────────────────────────────────────────────────

    listenForMessages() {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        console.log('[LI-Assist] Received:', msg.action);

        switch (msg.action) {
          case 'start':
            this.startAutomation(msg.settings).then(() => sendResponse({ success: true }));
            return true;

          case 'stop':
            this.stopAutomation();
            sendResponse({ success: true });
            break;

          case 'stopDm':
            this.stopDmAutomation();
            sendResponse({ success: true });
            break;

          case 'getStatus':
            sendResponse({ isRunning: this.isRunning, isDmRunning: this.isDmRunning, stats: this.stats });
            break;

          case 'ping':
            sendResponse({ alive: true });
            break;

          case 'getEnvStatus':
            this.detectEnvironment().then(() => sendResponse({ envStatus: this.envStatus }));
            return true;

          case 'checkCurrentConvo':
            this.checkCurrentConvo(msg.settings).then(result => sendResponse(result));
            return true;

          case 'replyCurrentConvo':
            this.replyCurrentConvo(msg.settings).then(result => sendResponse(result));
            return true;

          case 'continueDmLoop':
            this.settings = msg.settings;
            this.isDmRunning = true;
            this.repliedConversations = new Set(); // Fresh start
            this._inboxScrolled = true;
            this.processAllConversationsFromSidebar();
            sendResponse({ success: true });
            return true;

          case 'startDmFromCurrent':
            // Mark all conversations ABOVE the currently selected one as processed,
            // then start the normal DM loop (same rules apply: blue dot / ≥7d)
            this.settings = msg.settings;
            this.isDmRunning = true;
            this.repliedConversations = new Set();
            this._inboxScrolled = true;
            this.startFromCurrentConversation();
            sendResponse({ success: true });
            return true;

          default:
            sendResponse({ success: false, error: 'Unknown action' });
        }
        return true;
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DM AUTO-REPLY — SIDEBAR BASED (v7)
    // ═══════════════════════════════════════════════════════════════════════════

    async checkCurrentConvo(settings) {
      if (settings) this.settings = settings;
      const name = this.getCurrentConvoName();
      this.log(`Current convo: ${name}`, 'info');
      return { success: true, name };
    }

    async replyCurrentConvo(settings) {
      try {
        if (settings) this.settings = settings;
        const name = this.getCurrentConvoName();
        const conv = {
          name,
          firstName: name.split(' ')[0] || 'there',
          lastName: name.split(' ').slice(1).join(' ') || ''
        };

        this.log(`Sending reply to ${name}...`, 'info');
        const sent = await this.sendDmReply(conv);
        return sent
          ? { success: true, replied: true, name }
          : { success: false, replied: false, name, error: 'Failed to send' };
      } catch (error) {
        this.log(`Error: ${error.message}`, 'error');
        return { success: false, error: error.message };
      }
    }

    getCurrentConvoName() {
      const selectors = [
        'h2.msg-overlay-bubble-header__title',
        'h2.msg-entity-lockup__entity-title',
        '.msg-thread__link-to-profile',
        'header h2[class*="entity"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.textContent.trim().split('\n')[0].trim();
          if (text) return text;
        }
      }
      return 'Unknown';
    }

    /**
     * "Start From Here" — find the currently active/selected conversation in the sidebar,
     * mark everything above it as already processed, then run the normal DM loop.
     */
    async startFromCurrentConversation() {
      const items = document.querySelectorAll('li.msg-conversation-listitem');
      let foundActive = false;

      for (const item of items) {
        // Check if this item is the currently active/selected conversation
        const isActive = item.querySelector('.msg-conversations-container__convo-item-link--active') ||
                         item.classList.contains('active') ||
                         item.querySelector('[class*="--active"]');

        if (isActive) {
          foundActive = true;
          this.log(`Starting from: ${this.getItemName(item)}`, 'info');
          break; // Don't skip this one — the loop will evaluate it with normal rules
        }

        // Not active yet — mark as already processed so the loop skips it
        const name = this.getItemName(item);
        if (name) {
          this.repliedConversations.add(name);
        }
      }

      if (!foundActive) {
        this.log('Could not find active conversation. Starting from top.', 'warning');
        this.repliedConversations = new Set();
      } else {
        const skipped = this.repliedConversations.size;
        this.log(`Skipped ${skipped} conversations above current. Processing from here...`, 'info');
      }

      await this.saveRepliedConversations();
      await this.processAllConversationsFromSidebar();
    }

    /**
     * Get the name from a conversation list item (helper)
     */
    getItemName(item) {
      const nameEl = item.querySelector('h3.msg-conversation-listitem__participant-names');
      if (!nameEl) return '';
      const span = nameEl.querySelector('span.truncate');
      return span ? span.textContent.trim() : nameEl.textContent.trim().split('\n')[0].trim();
    }

    async runDmAutomation() {
      if (!this.isDmRunning) return;

      if (!window.location.href.includes('linkedin.com/messaging')) {
        this.log('Navigating to messaging...', 'info');
        window.location.href = 'https://www.linkedin.com/messaging/';
        return;
      }

      await this.sleep(2000);

      if (!this._inboxScrolled) {
        await this.scrollInbox();
        await this.sleep(1000);
        this._inboxScrolled = true;
      }

      await this.processAllConversationsFromSidebar();
    }

    async processAllConversationsFromSidebar() {
      let noMatchScrollAttempts = 0;
      const maxNoMatchScrollAttempts = 5;

      while (this.isDmRunning) {
        // Check stop signal FIRST every iteration
        if (await this.shouldStopDm()) {
          this.log('DM Reply stopped by user.', 'info');
          this.isDmRunning = false;
          this.notifyPopup();
          return;
        }

        const conv = await this.findNextConversationToReply();

        if (!conv) {
          // No matches in currently visible items.
          // Scroll down one page to load/de-occlude more items.
          if (noMatchScrollAttempts < maxNoMatchScrollAttempts) {
            noMatchScrollAttempts++;

            // Check stop again before scrolling
            if (await this.shouldStopDm()) {
              this.isDmRunning = false;
              this.notifyPopup();
              return;
            }

            this.log(`No more matches visible. Scrolling down... (${noMatchScrollAttempts}/${maxNoMatchScrollAttempts})`, 'info');
            const gotMore = await this.scrollInboxOnePageDown();

            if (!gotMore) {
              this.log('Reached bottom of inbox.', 'info');
              // One final attempt — maybe some items were just de-occluded
              noMatchScrollAttempts = maxNoMatchScrollAttempts;
            }
            continue;
          }

          this.log('✓ All conversations checked! Done.', 'success');
          this.isDmRunning = false;
          await this.clearDmAutomationState();
          this.notifyPopup();
          return;
        }

        // Found a match — reset scroll counter
        noMatchScrollAttempts = 0;

        // Check stop before opening
        if (await this.shouldStopDm()) {
          this.isDmRunning = false;
          this.notifyPopup();
          return;
        }

        this.log(`💬 Opening: ${conv.name} (${conv.reason})`, 'info');

        const clickTarget = conv.element.querySelector('.msg-conversation-listitem__link') ||
                            conv.element.querySelector('a') ||
                            conv.element.querySelector('.msg-conversation-card') ||
                            conv.element;
        await this.humanClick(clickTarget);
        await this.sleep(2500);

        // Check stop before sending
        if (await this.shouldStopDm()) {
          this.isDmRunning = false;
          this.notifyPopup();
          return;
        }

        const sent = await this.sendDmReply(conv);

        this.repliedConversations.add(conv.name);
        await this.saveRepliedConversations();

        if (sent) {
          const delay = this.getRandomDelay();
          this.log(`Waiting ${Math.round(delay / 1000)}s...`, 'info');

          // Check stop during delay (break it into chunks)
          const chunkMs = 1000;
          let waited = 0;
          while (waited < delay && this.isDmRunning) {
            await this.sleep(Math.min(chunkMs, delay - waited));
            waited += chunkMs;
            if (await this.shouldStopDm()) {
              this.isDmRunning = false;
              this.notifyPopup();
              return;
            }
          }
        } else {
          await this.sleep(1500);
        }
      }
    }

    /**
     * Scan sidebar conversations.
     * Rule 1: Unread indicator → REPLY
     * Rule 2: No unread, timestamp ≥7 days → REPLY (follow-up)
     * No unread + <7 days → SKIP
     *
     * Handles occluded items by scrolling them into view.
     */
    async findNextConversationToReply() {
      const items = document.querySelectorAll('li.msg-conversation-listitem');

      if (!items.length) {
        this.log('No conversations found in sidebar', 'warning');
        return null;
      }

      this.log(`Scanning ${items.length} conversations...`, 'info');

      for (const item of items) {
        // ── Get name from H3 ──
        let nameEl = item.querySelector('h3.msg-conversation-listitem__participant-names');

        // If no name H3, this item is likely occluded — scroll it into view
        if (!nameEl) {
          const deOccluded = await this.deOccludeItem(item);
          if (deOccluded) {
            nameEl = item.querySelector('h3.msg-conversation-listitem__participant-names');
          }
          if (!nameEl) {
            this.log(`  [?] Item still occluded after scroll, skipping`, 'warning');
            continue;
          }
        }

        const truncateSpan = nameEl.querySelector('span.truncate');
        let name = truncateSpan
          ? truncateSpan.textContent.trim()
          : nameEl.textContent.trim().split('\n')[0].trim();

        if (!name) {
          this.log(`  [?] Empty name, skipping`, 'warning');
          continue;
        }

        // Skip already processed this run
        if (this.repliedConversations.has(name)) continue;

        const firstName = name.split(' ')[0] || 'there';
        const lastName = name.split(' ').slice(1).join(' ') || '';

        // ── RULE 1: Check for unread indicator ──
        const isUnread = this.hasUnreadIndicator(item, nameEl);

        if (isUnread) {
          this.log(`🔵 ${name}: UNREAD → WILL REPLY`, 'success');
          return {
            element: item,
            name, firstName, lastName,
            reason: 'Unread message (blue dot)'
          };
        }

        // ── RULE 2: No unread → check timestamp ──
        const dateText = this.extractTimestamp(item);

        if (!dateText) {
          this.log(`⏭ ${name}: No timestamp found → SKIP`, 'info');
          this.repliedConversations.add(name);
          continue;
        }

        const messageDate = this.parseInboxTimestamp(dateText);
        const now = new Date();
        const daysAgo = (now.getTime() - messageDate.getTime()) / (1000 * 60 * 60 * 24);

        if (daysAgo >= 7) {
          this.log(`📅 ${name}: "${dateText}" (${daysAgo.toFixed(0)}d ago, ≥7) → WILL FOLLOW UP`, 'success');
          return {
            element: item,
            name, firstName, lastName,
            reason: `Follow-up (${daysAgo.toFixed(0)}d ago)`
          };
        } else {
          this.log(`⏭ ${name}: "${dateText}" (${daysAgo.toFixed(1)}d ago, <7) → SKIP`, 'info');
          this.repliedConversations.add(name);
          continue;
        }
      }

      this.saveRepliedConversations();
      return null;
    }

    /**
     * Detect unread indicator on a conversation list item.
     *
     * From the DOM we know:
     * - H3 class contains "t-normal" when read, "t-bold" when unread
     * - There may be notification badge elements
     * - The message snippet may also be bold when unread
     */
    hasUnreadIndicator(item, nameEl) {
      // Method 1: Check H3 class for "t-bold" (LinkedIn's text utility class)
      // Read conversations have "t-normal", unread have "t-bold"
      if (nameEl) {
        const classes = nameEl.className || '';
        if (classes.includes('t-bold')) {
          console.log(`[LI-Assist] Unread: H3 has t-bold class`);
          return true;
        }
      }

      // Method 2: Check computed font-weight on the name
      if (nameEl) {
        const weight = parseInt(window.getComputedStyle(nameEl).fontWeight);
        if (weight >= 600) {
          console.log(`[LI-Assist] Unread: name fontWeight=${weight}`);
          return true;
        }
      }

      // Method 3: Check for notification badge elements
      const badgeSelectors = [
        '.msg-conversation-card__unread-count',
        '.notification-badge--show',
        '.artdeco-notification-badge--is-visible',
        '[class*="unread-count"]',
        'span.notification-badge__count',
      ];
      for (const sel of badgeSelectors) {
        const el = item.querySelector(sel);
        if (el) {
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            console.log(`[LI-Assist] Unread: badge found via ${sel}`);
            return true;
          }
        }
      }

      // Method 4: Check the message snippet for bold
      const snippetEl = item.querySelector('p.msg-conversation-card__message-snippet');
      if (snippetEl) {
        const weight = parseInt(window.getComputedStyle(snippetEl).fontWeight);
        if (weight >= 600) {
          console.log(`[LI-Assist] Unread: snippet fontWeight=${weight}`);
          return true;
        }
      }

      // Method 5: Scan for any element containing "unread" in class
      const allEls = item.querySelectorAll('*');
      for (const el of allEls) {
        const cls = el.className;
        if (cls && typeof cls === 'string' && cls.includes('unread')) {
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            console.log(`[LI-Assist] Unread: found class containing "unread":`, cls);
            return true;
          }
        }
      }

      return false;
    }

    /**
     * Extract the timestamp text from a conversation list item.
     *
     * From DOM inspection:
     * - Visible timestamp is in the conversation card row area
     * - Accessible timestamp is in <span class="visually-hidden"> like "4:52 PM"
     * - There's also a <time> element sometimes
     *
     * We look for the timestamp in the row that contains the name + time.
     */
    extractTimestamp(item) {
      // Method 1: Look for a <time> element with datetime attribute
      const timeEl = item.querySelector('time');
      if (timeEl) {
        // Prefer datetime attribute if present
        const dt = timeEl.getAttribute('datetime');
        if (dt) {
          return dt; // ISO format
        }
        const text = timeEl.textContent.trim();
        if (text) return text;
      }

      // Method 2: Look for the time-stamp specific class
      const stampEl = item.querySelector('.msg-conversation-listitem__time-stamp, .msg-conversation-card__time-stamp, [class*="time-stamp"]');
      if (stampEl) {
        const text = stampEl.textContent.trim();
        if (text) return text;
      }

      // Method 3: Find the visually-hidden span that contains a time/date
      const hiddenSpans = item.querySelectorAll('span.visually-hidden');
      for (const span of hiddenSpans) {
        const text = span.textContent.trim();
        // Match time: "4:52 PM", "10:30 AM"
        if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(text)) return text;
        // Match date with year: "Dec 31, 2025", "Jan 5, 2024"
        if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}$/i.test(text)) return text;
        // Match date without year: "Feb 28", "Mar 1"
        if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}$/i.test(text)) return text;
        // Match: "Yesterday"
        if (text.toLowerCase() === 'yesterday') return text;
        // Match day names: "Monday", "Tuesday", etc.
        if (/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/i.test(text)) return text;
      }

      // Method 4: Look at any <p> or <span> with time-related text in the card rows
      const allTexts = item.querySelectorAll('.msg-conversation-card__row span, .msg-conversation-card__row p');
      for (const el of allTexts) {
        if (el.classList.contains('visually-hidden')) continue;
        const text = el.textContent.trim();
        if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(text)) return text;
        if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}$/i.test(text)) return text;
        if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}$/i.test(text)) return text;
        if (text.toLowerCase() === 'yesterday') return text;
        if (/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/i.test(text)) return text;
      }

      return '';
    }

    /**
     * Parse inbox timestamp strings.
     * "4:52 PM" → today, "Yesterday", "Monday", "Feb 28", ISO datetime
     */
    parseInboxTimestamp(text) {
      if (!text) return new Date();

      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      text = text.trim();

      // ISO datetime (from <time datetime="...">)
      if (text.includes('T') || text.includes('-')) {
        const d = new Date(text);
        if (!isNaN(d.getTime())) return d;
      }

      // Time only → today
      if (/^\d{1,2}:\d{2}\s*(AM|PM|am|pm)?$/i.test(text)) {
        return today;
      }

      // "Yesterday"
      if (text.toLowerCase() === 'yesterday') {
        return new Date(today.getTime() - 86400000);
      }

      // Day name
      const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const dayIdx = dayNames.indexOf(text.toLowerCase());
      if (dayIdx !== -1) {
        const currentDay = today.getDay();
        let daysAgo = currentDay - dayIdx;
        if (daysAgo <= 0) daysAgo += 7;
        return new Date(today.getTime() - daysAgo * 86400000);
      }

      // Month + Day + Year: "Dec 31, 2025", "Jan 5, 2024"
      const monthDayYearMatch = text.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})$/i);
      if (monthDayYearMatch) {
        const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const month = monthNames.indexOf(monthDayYearMatch[1].toLowerCase());
        const day = parseInt(monthDayYearMatch[2]);
        const year = parseInt(monthDayYearMatch[3]);
        if (month !== -1) {
          return new Date(year, month, day);
        }
      }

      // Month + Day (no year): "Feb 28", "Mar 1"
      const monthDayMatch = text.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})$/i);
      if (monthDayMatch) {
        const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const month = monthNames.indexOf(monthDayMatch[1].toLowerCase());
        const day = parseInt(monthDayMatch[2]);
        if (month !== -1) {
          let year = now.getFullYear();
          const date = new Date(year, month, day);
          if (date > now) year--;
          return new Date(year, month, day);
        }
      }

      // Relative
      let match = text.match(/^(\d+)d$/i);
      if (match) return new Date(today.getTime() - parseInt(match[1]) * 86400000);
      match = text.match(/^(\d+)w$/i);
      if (match) return new Date(today.getTime() - parseInt(match[1]) * 7 * 86400000);

      this.log(`Could not parse date: "${text}", assuming today`, 'warning');
      return today;
    }

    // ─── Send DM Reply ────────────────────────────────────────────────────────

    async sendDmReply(conv) {
      // Mark as replied first to prevent double-sends
      this.repliedConversations.add(conv.name);
      this.sentMessages.set(conv.name, Date.now());
      await this.saveRepliedConversations();
      await this.saveData();

      const message = this.parseDmTemplate(this.settings.dmReplyTemplate, conv);
      if (!message || !message.trim()) {
        this.log('DM reply template is empty!', 'warning');
        return false;
      }

      // Find message input
      const messageInput = this.findMessageInput();
      if (!messageInput) {
        this.log('Could not find message input box', 'warning');
        return false;
      }

      // Focus and clear
      messageInput.focus();
      await this.sleep(300);
      messageInput.innerHTML = '';
      messageInput.dispatchEvent(new Event('input', { bubbles: true }));
      await this.sleep(200);

      // Type message using multiple approaches

      // A: innerHTML with <p> tag
      messageInput.innerHTML = `<p>${message}</p>`;
      messageInput.dispatchEvent(new Event('input', { bubbles: true }));
      messageInput.dispatchEvent(new Event('change', { bubbles: true }));
      await this.sleep(300);

      // B: execCommand insertText
      try {
        messageInput.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, message);
      } catch (e) {}
      await this.sleep(300);

      // C: InputEvent for React
      messageInput.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true,
        inputType: 'insertText', data: message
      }));
      await this.sleep(200);

      // Blur + refocus to trigger state update
      messageInput.blur();
      await this.sleep(150);
      messageInput.focus();
      await this.sleep(500);

      this.log(`Typed: "${message.substring(0, 60)}${message.length > 60 ? '...' : ''}"`, 'info');

      // Find and click send button (wait for it to enable)
      let sendBtn = null;
      for (let attempt = 0; attempt < 15; attempt++) {
        sendBtn = this.findSendButton();
        if (sendBtn && !sendBtn.disabled) break;
        await this.sleep(300);
      }

      if (sendBtn && !sendBtn.disabled) {
        await this.humanClick(sendBtn);
        await this.sleep(1500);
        this.stats.dmReplied = (this.stats.dmReplied || 0) + 1;
        await this.saveData();
        this.log(`✓ Replied to: ${conv.name}`, 'success');
        this.notifyPopup();
        return true;
      }

      // Fallback: Enter key
      this.log('Send button disabled, trying Enter...', 'warning');
      messageInput.focus();
      await this.sleep(200);
      messageInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
      await this.sleep(1000);

      const btnAfter = this.findSendButton();
      if (!btnAfter || btnAfter.disabled) {
        this.stats.dmReplied = (this.stats.dmReplied || 0) + 1;
        await this.saveData();
        this.log(`✓ Replied to: ${conv.name} (via Enter)`, 'success');
        this.notifyPopup();
        return true;
      }

      this.log(`✗ Could not send to: ${conv.name}`, 'error');
      return false;
    }

    findMessageInput() {
      const selectors = [
        '.msg-form__contenteditable[contenteditable="true"]',
        'div.msg-form__contenteditable',
        '.msg-form__msg-content-container [contenteditable="true"]',
        'div[role="textbox"][contenteditable="true"]',
        'div[contenteditable="true"][aria-label*="message"]',
        'div[contenteditable="true"][aria-label*="Message"]',
        'div[contenteditable="true"][data-placeholder]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    }

    findSendButton() {
      const selectors = [
        '.msg-form__send-button',
        'button.msg-form__send-btn',
        'button[type="submit"][class*="msg-form"]',
        'button[aria-label="Send"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      // Fallback: button with text "Send" inside msg form
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === 'Send' && btn.closest('[class*="msg-form"]')) {
          return btn;
        }
      }
      return null;
    }

    parseDmTemplate(template, conv) {
      if (!template) return '';
      return template
        .replace(/\{\{firstName\}\}/gi, conv.firstName || 'there')
        .replace(/\{\{lastName\}\}/gi, conv.lastName || '')
        .replace(/  +/g, ' ')
        .trim();
    }

    // ─── Inbox scrolling ──────────────────────────────────────────────────────

    /**
     * Get the scrollable UL container for conversations.
     */
    getInboxScrollContainer() {
      return document.querySelector('ul.msg-conversations-container__conversations-list');
    }

    /**
     * Light initial scroll — just scroll down a bit and back to prime the list.
     * We do NOT try to load the entire inbox. The main processing loop
     * will scroll incrementally as it needs more items.
     */
    async scrollInbox() {
      const ul = this.getInboxScrollContainer();
      if (!ul) {
        this.log('Could not find inbox UL container', 'warning');
        return;
      }

      const count = document.querySelectorAll('li.msg-conversation-listitem').length;
      this.log(`Inbox ready: ${count} conversations loaded`, 'info');

      // Just a small scroll to ensure first batch is de-occluded, then back to top
      ul.scrollTop = 300;
      ul.dispatchEvent(new Event('scroll', { bubbles: true }));
      await this.sleep(500);
      ul.scrollTop = 0;
      ul.dispatchEvent(new Event('scroll', { bubbles: true }));
      await this.sleep(500);
    }

    /**
     * Scroll the inbox down by one "page" (~700px) to load the next batch.
     * Returns true if new items appeared.
     */
    async scrollInboxOnePageDown() {
      const ul = this.getInboxScrollContainer();
      if (!ul) return false;

      const prevCount = document.querySelectorAll('li.msg-conversation-listitem').length;
      const prevScroll = ul.scrollTop;

      // Scroll down by one viewport height
      ul.scrollTop += ul.clientHeight;
      ul.dispatchEvent(new Event('scroll', { bubbles: true }));
      await this.sleep(1500);

      const newCount = document.querySelectorAll('li.msg-conversation-listitem').length;

      // Check if we actually scrolled (didn't hit bottom) or got new items
      if (newCount > prevCount) {
        this.log(`Scrolled: ${newCount} conversations now (was ${prevCount})`, 'info');
        return true;
      }

      if (ul.scrollTop > prevScroll) {
        // We scrolled but no new items — items may have been de-occluded
        return true;
      }

      // Didn't scroll at all — we're at the bottom
      return false;
    }

    /**
     * Scroll a specific conversation item into view so LinkedIn de-occludes it.
     * Returns true if the item now has a name H3.
     */
    async deOccludeItem(item) {
      const ul = this.getInboxScrollContainer();
      if (!ul) return false;

      item.scrollIntoView({ behavior: 'instant', block: 'center' });
      ul.dispatchEvent(new Event('scroll', { bubbles: true }));
      await this.sleep(600);

      const nameEl = item.querySelector('h3.msg-conversation-listitem__participant-names');
      return !!nameEl;
    }

    // ─── DM Stop / State ──────────────────────────────────────────────────────

    stopDmAutomation() {
      this.isDmRunning = false;
      this.log('DM Reply stopped.', 'info');
      this.clearDmAutomationState();
    }

    async shouldStopDm() {
      const dmState = await this.getStorageValue('dmAutomationState');
      return !dmState || !dmState.isRunning;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONNECTION AUTOMATION (ported from working v3)
    // ═══════════════════════════════════════════════════════════════════════════

    async startAutomation(settings) {
      if (this.isRunning) { this.log('Already running.', 'warning'); return; }

      await this.loadData();
      this.settings = settings;
      this.isRunning = true;

      this.keywords = (settings.keywordList || '').split(',').map(k => k.trim()).filter(k => k);
      this.currentKeywordIndex = 0;

      if (!this.keywords.length) { this.log('No keywords found.', 'error'); this.isRunning = false; return; }

      this.log(`Starting with ${this.keywords.length} keywords...`, 'info');
      await this.persistAutomationState();
      await this.navigateToKeyword(this.keywords[0]);
    }

    stopAutomation() {
      this.isRunning = false;
      this.clearAutomationState();
      this.log('Automation stopped.', 'info');
    }

    async persistAutomationState() {
      await this.setStorageValue('automationState', {
        isRunning: true, settings: this.settings,
        keywords: this.keywords, currentKeywordIndex: this.currentKeywordIndex
      });
    }

    async clearAutomationState() {
      await this.setStorageValue('automationState', null);
    }

    async shouldStop() {
      const state = await this.getStorageValue('automationState');
      return !state || !state.isRunning;
    }

    async navigateToKeyword(keyword) {
      this.log(`Searching: "${keyword}"`, 'info');
      window.location.href = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keyword)}&origin=SWITCH_SEARCH_VERTICAL`;
    }

    async moveToNextKeyword() {
      this.currentKeywordIndex++;
      if (this.currentKeywordIndex >= this.keywords.length) {
        this.log('All keywords done!', 'success');
        this.isRunning = false;
        await this.clearAutomationState();
        this.notifyPopup();
        return;
      }
      const nextKeyword = this.keywords[this.currentKeywordIndex];
      this.log(`Moving to next keyword: "${nextKeyword}"`, 'info');
      await this.persistAutomationState();
      await this.navigateToKeyword(nextKeyword);
    }

    async goToNextPage() {
      if (await this.shouldStop()) {
        this.isRunning = false;
        this.notifyPopup();
        return false;
      }

      // URL-based pagination (most reliable for LinkedIn search)
      const currentUrl = window.location.href;
      if (currentUrl.includes('linkedin.com/search')) {
        const pageMatch = currentUrl.match(/[?&]page=(\d+)/i);
        const currentPage = pageMatch ? parseInt(pageMatch[1]) : 1;
        const nextPage = currentPage + 1;

        let newUrl;
        if (pageMatch) {
          newUrl = currentUrl.replace(/page=\d+/i, `page=${nextPage}`);
        } else {
          newUrl = currentUrl + (currentUrl.includes('?') ? '&' : '?') + `page=${nextPage}`;
        }

        this.log(`Going to search page ${nextPage}...`, 'info');
        await this.persistAutomationState();
        window.location.href = newUrl;
        return true;
      }

      // Try clicking Next button
      const nextBtn = this.findNextButton();
      if (nextBtn) {
        this.log('Clicking Next page button...', 'info');
        await this.persistAutomationState();
        nextBtn.click();
        return true;
      }

      return false;
    }

    findNextButton() {
      const allButtons = document.querySelectorAll('button, a[role="button"], a');
      for (const btn of allButtons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        if ((text === 'next' || aria.includes('next')) && !btn.disabled && btn.offsetParent !== null) {
          return btn;
        }
      }
      return null;
    }

    // ─── Profile processing loop (from working v3) ──────────────────────────

    async processNextProfile() {
      if (!this.isRunning) return;

      if (await this.shouldStop()) {
        this.log('Automation stopped by user.', 'info');
        this.isRunning = false;
        this.notifyPopup();
        return;
      }

      if (this.stats.sent >= (this.settings.dailyLimit || 20)) {
        this.log('Daily limit reached! Stopping.', 'warning');
        this.isRunning = false;
        await this.clearAutomationState();
        this.notifyPopup();
        return;
      }

      // Wait for page to be ready
      await this.waitForPageLoad();

      // Cache profiles per page URL
      const currentUrl = window.location.href;
      if (this._cachedPageUrl !== currentUrl) {
        this._cachedPageUrl = currentUrl;
        this._cachedProfiles = null;
      }

      if (!this._cachedProfiles) {
        this._cachedProfiles = await this.findAllConnectableProfiles();
        this.log(`Found ${this._cachedProfiles.length} connectable profiles on this page`, 'info');
      }

      const profiles = this._cachedProfiles;

      if (profiles.length === 0) {
        this.log('No connectable profiles. Going to next page...', 'info');
        const navigated = await this.goToNextPage();
        if (!navigated) {
          this.log('No more pages. Moving to next keyword...', 'info');
          await this.moveToNextKeyword();
        }
        return;
      }

      // Find next unprocessed profile
      let targetProfile = null;
      for (const p of profiles) {
        if (!this.processedProfiles.has(p.url)) {
          targetProfile = p;
          break;
        }
      }

      if (!targetProfile) {
        this.log(`All ${profiles.length} profiles processed. Going to next page...`, 'info');
        this._cachedProfiles = null;
        const navigated = await this.goToNextPage();
        if (!navigated) {
          this.log('No more pages. Moving to next keyword...', 'info');
          await this.moveToNextKeyword();
        }
        return;
      }

      // Connect
      await this.connectToProfile(targetProfile);
    }

    // ─── Page load waiting ──────────────────────────────────────────────────

    async waitForPageLoad() {
      let attempts = 0;
      while (attempts < 40) {
        const hasContent =
          document.querySelector('a[href*="/in/"]') ||
          document.querySelector('[class*="search-result"]') ||
          document.querySelector('[class*="reusable-search"]') ||
          document.querySelector('main');
        if (hasContent) {
          await this.sleep(1500);
          return;
        }
        await this.sleep(200);
        attempts++;
      }
      this.log('Page load timeout — proceeding anyway', 'warning');
    }

    // ─── Profile finding (3-approach from v3) ───────────────────────────────

    async findAllConnectableProfiles() {
      const profiles = [];
      const seenUrls = new Set();

      // Scroll to trigger lazy-loading
      await this.scrollPage();

      // Find all Connect buttons
      const connectButtons = this.findAllConnectButtons();
      this.log(`Found ${connectButtons.length} Connect buttons on page`, 'info');

      for (const btn of connectButtons) {
        const profile = this.buildProfileFromButton(btn);
        if (!profile) continue;
        if (seenUrls.has(profile.url)) continue;
        seenUrls.add(profile.url);
        profiles.push(profile);
      }

      // Check behind "More" buttons
      const moreProfiles = await this.findProfilesBehindMoreButton(seenUrls);
      for (const p of moreProfiles) {
        if (!seenUrls.has(p.url)) {
          seenUrls.add(p.url);
          profiles.push(p);
        }
      }

      return profiles;
    }

    findAllConnectButtons() {
      const results = [];
      const seen = new Set();

      // APPROACH 1: aria-label
      const connectByAria = document.querySelectorAll('button[aria-label*="Invite"][aria-label*="connect"], button[aria-label*="Connect"]');
      for (const btn of connectByAria) {
        if (!seen.has(btn) && btn.offsetParent !== null) {
          seen.add(btn);
          results.push(btn);
        }
      }

      // APPROACH 2: SVG connect-small icon → walk up to clickable
      const connectSvgs = document.querySelectorAll('svg#connect-small, svg[data-supported-dps="connect-small"]');
      for (const svg of connectSvgs) {
        let clickable = null;
        let node = svg.parentElement;
        for (let i = 0; i < 12; i++) {
          if (!node || node === document.body) break;
          const tag = node.tagName;
          const role = node.getAttribute('role') || '';
          if (tag === 'BUTTON' || tag === 'A' || role === 'button' || role === 'link') {
            clickable = node;
            break;
          }
          node = node.parentElement;
        }
        if (!clickable) {
          clickable = svg.closest('a, button, [role="button"], [role="link"]');
          if (!clickable) clickable = svg.parentElement;
        }
        if (!clickable || seen.has(clickable)) continue;

        const fullText = (clickable.textContent || '').toLowerCase();
        const aria = (clickable.getAttribute('aria-label') || '').toLowerCase();
        const isExcluded =
          fullText.includes('disconnect') || fullText.includes('message') ||
          fullText.includes('pending') || fullText.includes('withdraw') ||
          aria.includes('disconnect') || aria.includes('message') ||
          aria.includes('pending') || aria.includes('withdraw');

        if (!isExcluded) {
          seen.add(clickable);
          results.push(clickable);
        }
      }

      // APPROACH 3: Text-based fallback
      if (results.length === 0) {
        const allEls = document.querySelectorAll('span, div');
        for (const el of allEls) {
          if (el.textContent.trim() !== 'Connect') continue;
          const clickable = el.closest('a, button, [role="button"], [role="link"], li[tabindex]');
          if (!clickable || seen.has(clickable)) continue;
          const fullText = (clickable.textContent || '').toLowerCase();
          const isExcluded =
            fullText.includes('disconnect') || fullText.includes('message') ||
            fullText.includes('pending') || fullText.includes('withdraw');
          if (!isExcluded) {
            seen.add(clickable);
            results.push(clickable);
          }
        }
      }

      return results;
    }

    async findProfilesBehindMoreButton(seenUrls) {
      const profiles = [];
      const allButtons = document.querySelectorAll('button');
      const moreButtons = [];

      for (const btn of allButtons) {
        if (btn.disabled) continue;
        const style = window.getComputedStyle(btn);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const text = (btn.textContent || '').trim().toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (text === 'more' || text === '...' || text === '•••' || aria.includes('more actions')) {
          moreButtons.push(btn);
        }
      }

      for (const moreBtn of moreButtons) {
        const container = this.getProfileContainer(moreBtn);
        if (!container) continue;
        const link = container.querySelector('a[href*="/in/"]');
        if (!link || seenUrls.has(link.href)) continue;

        try {
          moreBtn.click();
          await this.sleep(400);
          const dropdown = document.querySelector('[role="menu"], .artdeco-dropdown__content-inner, .artdeco-dropdown__content');
          if (dropdown && dropdown.offsetParent !== null) {
            const items = dropdown.querySelectorAll('[role="menuitem"], button, div[role="button"]');
            for (const item of items) {
              const itemText = (item.textContent || '').trim().toLowerCase();
              if (itemText === 'connect' || itemText.includes('connect')) {
                const profile = this.buildProfileFromButton(item, container);
                if (profile) profiles.push(profile);
                break;
              }
            }
          }
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await this.sleep(200);
        } catch (e) {}
      }

      return profiles;
    }

    buildProfileFromButton(btn, overrideContainer) {
      try {
        // Extract name from Connect button aria-label (most reliable)
        let nameFromAria = '';
        const btnAria = btn.getAttribute('aria-label') || '';
        let inviteMatch = btnAria.match(/Invite\s+(.+?)\s+to connect/i);
        if (inviteMatch && inviteMatch[1]) {
          nameFromAria = inviteMatch[1].trim();
        } else {
          inviteMatch = btnAria.match(/Invite\s+(.+)/i);
          if (inviteMatch && inviteMatch[1]) {
            nameFromAria = inviteMatch[1].trim().replace(/\s+to\s*connect.*$/i, '').replace(/\s+to\s*$/i, '').trim();
          }
        }

        if (nameFromAria) {
          const firstName = nameFromAria.split(' ')[0] || '';
          const lastName = nameFromAria.split(' ').slice(1).join(' ') || '';
          let url = '';
          let title = '';
          let company = '';

          let node = btn;
          for (let i = 0; i < 8; i++) {
            if (!node.parentElement) break;
            node = node.parentElement;
            const profileLink = node.querySelector('a[href*="/in/"]');
            if (profileLink) {
              url = profileLink.href.split('?')[0];
              const titleEl = node.querySelector('.entity-result__primary-subtitle, [class*="subtitle"], [class*="headline"]');
              if (titleEl) title = titleEl.textContent.trim();
              const companyEl = node.querySelector('.entity-result__secondary-subtitle, [class*="secondary"]');
              if (companyEl) company = companyEl.textContent.trim();
              break;
            }
          }

          // Get full card text for keyword matching
          let fullText = nameFromAria.toLowerCase();
          let profileCard = btn;
          for (let i = 0; i < 10; i++) {
            if (!profileCard.parentElement) break;
            profileCard = profileCard.parentElement;
            const hasLink = profileCard.querySelector('a[href*="/in/"]');
            const isCard = profileCard.tagName === 'LI' ||
              (profileCard.className && (profileCard.className.includes('result') || profileCard.className.includes('card') || profileCard.className.includes('entity')));
            if (hasLink && isCard) {
              fullText = profileCard.textContent.replace(/\s+/g, ' ').toLowerCase();
              break;
            }
          }

          return {
            name: nameFromAria, firstName, lastName, title, company,
            degree: 2, url: url || `unknown-${Date.now()}`,
            fullText, _connectButton: btn, _container: profileCard
          };
        }

        // Fallback: walk up to profile container
        const container = overrideContainer || this.getProfileContainer(btn);
        if (!container) return null;
        const link = container.querySelector('a[href*="/in/"]');
        if (!link) return null;
        const url = link.href.split('?')[0];
        if (!url || url.includes('/feed/') || url.includes('/jobs/')) return null;

        let name = '';
        const linkAria = link.getAttribute('aria-label') || '';
        if (linkAria) name = linkAria.replace(/view\s+/i, '').replace(/'s\s+profile/i, '').trim();
        if (!name || name.length > 60) {
          for (const sel of ['[class*="entity-result__title-text"] span[aria-hidden="true"]', 'span[aria-hidden="true"]']) {
            const el = container.querySelector(sel);
            if (el && el.textContent.trim() && el.textContent.trim().length < 60) {
              name = el.textContent.trim();
              break;
            }
          }
        }
        if (!name) name = link.textContent.trim().split('\n')[0].trim() || 'Unknown';
        if (name.length > 60) name = name.substring(0, 60);
        name = name.replace(/^(Dr\.?|Mr\.?|Ms\.?|Mrs\.?|Prof\.?)\s+/i, '').replace(/\s+/g, ' ').trim();

        let title = '';
        const titleEl = container.querySelector('.entity-result__primary-subtitle, [class*="subtitle"]');
        if (titleEl) title = titleEl.textContent.trim();

        let company = '';
        const companyEl = container.querySelector('.entity-result__secondary-subtitle, [class*="secondary"]');
        if (companyEl) company = companyEl.textContent.trim();

        const degree = this.extractDegree(container);

        return {
          name, firstName: name.split(' ')[0] || '', lastName: name.split(' ').slice(1).join(' ') || '',
          title, company, degree, url,
          fullText: `${name} ${title} ${company}`.toLowerCase(),
          _connectButton: btn, _container: container
        };
      } catch (e) {
        return null;
      }
    }

    getProfileContainer(element) {
      let node = element;
      for (let i = 0; i < 12; i++) {
        if (!node.parentElement) break;
        node = node.parentElement;
        const hasProfileLink = node.querySelector('a[href*="/in/"]');
        const isCard = node.tagName === 'LI' ||
          (node.className && (node.className.includes('result') || node.className.includes('card') || node.className.includes('entity')));
        if (hasProfileLink && isCard) return node;
        if (hasProfileLink && node.children.length > 3) return node;
      }
      return null;
    }

    extractDegree(container) {
      const text = container.textContent || '';
      if (text.includes('1st')) return 1;
      if (text.includes('2nd')) return 2;
      if (text.includes('3rd') || text.includes('3+')) return 3;
      return 2;
    }

    matchesKeywords(profile) {
      if (!this.settings.enableKeywordFilter) return true;
      const keywordList = (this.settings.keywordList || '');
      if (!keywordList) return true;
      const keywords = keywordList.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
      return keywords.some(kw => (profile.fullText || '').includes(kw));
    }

    // ─── Connect action (from v3 with shadow DOM support) ───────────────────

    async connectToProfile(profile) {
      if (!this.isRunning) return;

      this.log(`Connecting to: ${profile.name} (${profile.title || 'No title'})`, 'info');
      await this.humanClick(profile._connectButton);
      await this.sleep(1200 + Math.random() * 600);

      const success = await this.handleConnectModal(profile);

      this.processedProfiles.add(profile.url);
      this.stats.processed++;

      if (success) {
        this.stats.sent++;
        this.log(`✓ Connected to: ${profile.name}`, 'success');
      } else {
        this.log(`Skipped (no modal or email required): ${profile.name}`, 'warning');
      }

      await this.saveData();
      this.notifyPopup();

      if (this.isRunning) {
        const delay = this.getRandomDelay();
        this.log(`Waiting ${Math.round(delay / 1000)}s before next...`, 'info');
        await this.sleep(delay);
        await this.processNextProfile();
      }
    }

    async handleConnectModal(profile) {
      this.log('Waiting for invitation modal...', 'info');

      let addNoteBtn = null;
      let sendWithoutNoteBtn = null;
      let sendBtn = null;

      // Helper to get all search roots (including shadow DOM)
      const getSearchRoots = () => {
        const roots = [document];
        const shadowHost = document.querySelector('.theme--light');
        if (shadowHost && shadowHost.shadowRoot) roots.push(shadowHost.shadowRoot);
        document.querySelectorAll('*').forEach(el => {
          if (el.shadowRoot && !roots.includes(el.shadowRoot)) roots.push(el.shadowRoot);
        });
        return roots;
      };

      // Poll for modal buttons (up to 6s)
      for (let attempt = 0; attempt < 30; attempt++) {
        await this.sleep(200);
        for (const root of getSearchRoots()) {
          for (const btn of root.querySelectorAll('button')) {
            const t = (btn.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase();
            if ((t === 'add a note' || t.includes('add a note')) && !addNoteBtn) addNoteBtn = btn;
            if ((t === 'send without a note' || t.includes('send without')) && !sendWithoutNoteBtn) sendWithoutNoteBtn = btn;
          }
          for (const span of root.querySelectorAll('.artdeco-button__text')) {
            const t = (span.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase();
            if (t.includes('add a note') && !addNoteBtn) addNoteBtn = span.closest('button') || span.parentElement;
            if (t.includes('send without') && !sendWithoutNoteBtn) sendWithoutNoteBtn = span.closest('button') || span.parentElement;
          }
        }
        if (addNoteBtn || sendWithoutNoteBtn) break;
      }

      // Check rate limit
      let bodyText = document.body.textContent.toLowerCase();
      const shadowHost = document.querySelector('.theme--light');
      if (shadowHost && shadowHost.shadowRoot) bodyText += ' ' + (shadowHost.shadowRoot.textContent || '').toLowerCase();
      if (bodyText.includes('weekly invitation limit') || bodyText.includes('reached the weekly limit')) {
        this.log('⚠️ LinkedIn weekly limit reached! Stopping.', 'error');
        this.isRunning = false;
        await this.clearAutomationState();
        this.notifyPopup();
        return false;
      }

      // Check email required
      let emailRequired = document.querySelector('input[type="email"], input[name="email"]');
      if (!emailRequired && shadowHost && shadowHost.shadowRoot) {
        emailRequired = shadowHost.shadowRoot.querySelector('input[type="email"], input[name="email"]');
      }
      if (emailRequired) {
        this.log('Email required - closing.', 'warning');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return false;
      }

      if (!addNoteBtn && !sendWithoutNoteBtn) {
        this.log('No invitation buttons found after 6s', 'warning');
        return false;
      }

      // Add note + send
      if (addNoteBtn && this.settings.template && this.settings.template.trim()) {
        await this.humanClick(addNoteBtn);
        await this.sleep(800 + Math.random() * 400);

        // Find textarea (search shadow DOM too)
        let textarea = null;
        for (let i = 0; i < 15; i++) {
          for (const root of getSearchRoots()) {
            textarea = root.querySelector('textarea[name="message"], textarea[id*="custom-message"], textarea');
            if (textarea && textarea.offsetParent !== null) break;
            textarea = null;
          }
          if (textarea) break;
          await this.sleep(200);
        }

        if (textarea) {
          const message = this.parseTemplate(this.settings.template, profile);
          textarea.focus();
          await this.sleep(100);
          textarea.value = '';
          textarea.dispatchEvent(new Event('input', { bubbles: true }));

          // Type via React native setter
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          nativeSetter.call(textarea, message);
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
          await this.sleep(300);
        }

        // Find Send button
        await this.sleep(300);
        for (const root of getSearchRoots()) {
          for (const btn of root.querySelectorAll('button')) {
            const t = (btn.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase();
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            if ((t === 'send' || t === 'send invitation' || t.includes('send now') || aria.includes('send invitation')) && btn.offsetParent !== null) {
              sendBtn = btn;
              break;
            }
          }
          if (sendBtn) break;
          for (const span of root.querySelectorAll('.artdeco-button__text')) {
            const t = (span.textContent || '').trim().toLowerCase();
            if (t === 'send' || t === 'send invitation') {
              sendBtn = span.closest('button') || span.parentElement;
              break;
            }
          }
          if (sendBtn) break;
        }

        if (sendBtn) {
          await this.humanClick(sendBtn);
          await this.sleep(1200 + Math.random() * 500);
          return true;
        }
      } else if (sendWithoutNoteBtn) {
        await this.humanClick(sendWithoutNoteBtn);
        await this.sleep(1200 + Math.random() * 500);
        return true;
      }

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return false;
    }

    parseTemplate(template, profile) {
      if (!template) return `Hi ${profile.firstName || 'there'},\nI'd love to connect.\nBest regards`;
      return template
        .replace(/\{\{firstName\}\}/gi, profile.firstName || 'there')
        .replace(/\{\{lastName\}\}/gi, profile.lastName || '')
        .replace(/\{\{company\}\}/gi, profile.company || 'your company')
        .replace(/\{\{title\}\}/gi, profile.title || 'your role')
        .replace(/  +/g, ' ')
        .trim();
    }

    // ─── Utility ──────────────────────────────────────────────────────────────

    getRandomDelay() {
      const min = ((this.settings && this.settings.minDelay) || 2) * 1000;
      const max = ((this.settings && this.settings.maxDelay) || 3) * 1000;
      const shouldPauseLonger = Math.random() < 0.05;
      const extraPause = shouldPauseLonger ? Math.random() * 1000 : 0;
      return Math.floor(Math.random() * (max - min)) + min + extraPause;
    }

    async humanClick(element) {
      try {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await this.sleep(300 + Math.random() * 200);
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2 + (Math.random() - 0.5) * 10;
        const y = rect.top + rect.height / 2 + (Math.random() - 0.5) * 10;
        element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, view: window, clientX: x, clientY: y }));
        await this.sleep(50 + Math.random() * 100);
        element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window, clientX: x, clientY: y }));
        element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window, clientX: x, clientY: y }));
        await this.sleep(100 + Math.random() * 150);
        if (element.focus) element.focus();
        await this.sleep(50);
        element.click();
        return true;
      } catch (e) {
        try { element.click(); return true; } catch (e2) { return false; }
      }
    }

    async scrollPage() {
      window.scrollTo(0, 0);
      await this.sleep(300);
      window.scrollTo(0, document.body.scrollHeight);
      await this.sleep(1000);
      window.scrollTo(0, document.body.scrollHeight / 2);
      await this.sleep(500);
    }

    sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    log(message, type = 'info') {
      const ts = new Date().toLocaleTimeString();
      console.log(`[LI-Assist ${ts}] ${message}`);
      try { chrome.runtime.sendMessage({ type: 'log', message, logType: type, timestamp: ts }); } catch (e) {}
    }

    notifyPopup() {
      try { chrome.runtime.sendMessage({ type: 'statsUpdate', stats: this.stats }); } catch (e) {}
    }
  }

  window.__linkedinAssistantInstance = new LinkedInContentScript();
})();
