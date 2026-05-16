/**
 * ═══════════════════════════════════════════════════════════════
 *  DISTORE CLOUD BRIDGE v3.0
 *  by Dilly Solutions
 * ═══════════════════════════════════════════════════════════════
 *
 *  Add before </body> in distore-pos-v13.html:
 *  <script src="distore-cloud.js"></script>
 *
 *  FEATURES:
 *  ✅ Offline-first — POS always works without server
 *  ✅ Real feature gates — M-PESA, eTIMS, Reports, etc.
 *  ✅ Full POS lock (localStorage — survives reload/restart)
 *  ✅ Online enforcement — when device reconnects, server
 *     state is applied immediately (lock, feature gates, etc.)
 *  ✅ Module injection — admin pushes HTML/CSS/JS modules
 *  ✅ Update pusher — admin pushes patches applied at load
 *  ✅ Multi-server — device saves server list, can switch
 *  ✅ Remote commands — lock, unlock, logout, message, reload
 * ═══════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  // ── Wait for POS app to be ready ─────────────────────────────
  function waitFor(fn, cb, ms) {
    if (fn()) { cb(); return; }
    const t = setInterval(() => { if (fn()) { clearInterval(t); cb(); } }, ms || 400);
  }

  waitFor(() => typeof Settings !== 'undefined' && typeof Auth !== 'undefined', bootBridge, 500);

  // ══════════════════════════════════════════════════════════════
  //  FEATURE GATE ENGINE
  //  Reads server features and enforces them on the POS UI
  // ══════════════════════════════════════════════════════════════
  const FeatureGate = {
    // Map of feature key → selectors/functions to disable
    GATES: {
      mpesa:         { label:'M-PESA Payments',   selectors:['#mpesa-btn','#btn-mpesa','[data-feature="mpesa"]','.mpesa-section','.mpesa-btn'] },
      etims:         { label:'eTIMS / KRA Tax',   selectors:['#etims-btn','[data-feature="etims"]','.etims-section','#btn-etims'] },
      reports:       { label:'Reports',           selectors:['[data-nav="reports"]','#nav-reports','.nav-reports','[data-page="reports"]'] },
      analytics:     { label:'Analytics',         selectors:['[data-nav="analytics"]','#nav-analytics','.nav-analytics'] },
      multi_cashier: { label:'Multi-Cashier',     selectors:['#btn-add-cashier','[data-feature="multi_cashier"]'] },
      credit:        { label:'Credit & Layaway',  selectors:['[data-nav="credit"]','#nav-credit','.nav-credit','[data-feature="credit"]'] },
      payroll:       { label:'Payroll',           selectors:['[data-nav="payroll"]','#nav-payroll','.nav-payroll'] },
      repair:        { label:'Repair Module',     selectors:['[data-nav="repair"]','#nav-repair','.nav-repair'] },
      supplier:      { label:'Supplier Mgmt',     selectors:['[data-nav="supplier"]','#nav-supplier','.nav-supplier'] },
      stocktake:     { label:'Stock Take',        selectors:['[data-nav="stocktake"]','#nav-stocktake','.nav-stocktake'] },
    },

    // Current feature state from server
    _features: {},

    // Apply all feature gates from server state
    apply(features) {
      this._features = features || {};
      // Store in localStorage for offline enforcement
      try { localStorage.setItem('distore_features', JSON.stringify(this._features)); } catch(e) {}

      for (const [key, gate] of Object.entries(this.GATES)) {
        const allowed = this._features[key] !== false; // default allow if not specified
        this._applyGate(key, gate, allowed);
      }
      console.log('[FeatureGate] Applied:', this._features);
    },

    // Load from localStorage (offline mode)
    loadCached() {
      try {
        const cached = JSON.parse(localStorage.getItem('distore_features') || '{}');
        if (Object.keys(cached).length > 0) {
          this.apply(cached);
        }
      } catch(e) {}
    },

    _applyGate(key, gate, allowed) {
      for (const sel of gate.selectors) {
        try {
          document.querySelectorAll(sel).forEach(el => {
            if (!allowed) {
              // Lock it
              el.style.opacity = '0.4';
              el.style.pointerEvents = 'none';
              el.style.cursor = 'not-allowed';
              el.title = `🔒 ${gate.label} — not in your plan. Contact support.`;
              el.setAttribute('data-locked', 'true');
              // Add lock badge if not already there
              if (!el.querySelector('.feature-lock-badge')) {
                const badge = document.createElement('span');
                badge.className = 'feature-lock-badge';
                badge.style.cssText = 'position:absolute;top:4px;right:4px;background:#ff4a6e;color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:10px;pointer-events:none;z-index:99';
                badge.textContent = '🔒';
                if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
                el.appendChild(badge);
              }
            } else {
              // Unlock it
              el.style.opacity = '';
              el.style.pointerEvents = '';
              el.style.cursor = '';
              el.title = '';
              el.removeAttribute('data-locked');
              const badge = el.querySelector('.feature-lock-badge');
              if (badge) badge.remove();
            }
          });
        } catch(e) {}
      }

      // Also intercept click events for locked features
      if (!allowed) {
        this._interceptClicks(key, gate.label);
      }
    },

    _interceptClicks(key, label) {
      // Block clicks on locked feature elements
      document.addEventListener('click', (e) => {
        const locked = e.target.closest('[data-locked="true"]');
        if (locked) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const contact = CloudBridge._supportContact || 'evansmaina2026@gmail.com';
          const phone   = CloudBridge._supportPhone   || '0114698986';
          // Show locked modal
          this._showLockedModal(label, contact, phone);
        }
      }, true); // capture phase — runs before app handlers
    },

    _showLockedModal(featureName, contact, phone) {
      // Remove existing if any
      document.getElementById('feature-lock-modal')?.remove();
      const el = document.createElement('div');
      el.id = 'feature-lock-modal';
      el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:999998;display:flex;align-items:center;justify-content:center;padding:20px';
      el.innerHTML = `
        <div style="background:#111318;border:1px solid #ff4a6e;border-radius:12px;padding:28px;max-width:360px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.6)">
          <div style="font-size:48px;margin-bottom:10px">🔒</div>
          <div style="font-size:18px;font-weight:900;color:#ff4a6e;margin-bottom:6px">${featureName} Locked</div>
          <div style="font-size:13px;color:#9aa3b8;margin-bottom:20px;line-height:1.6">
            This feature is not included in your current plan.<br>Contact your provider to unlock it.
          </div>
          <div style="background:#0a0b0e;border:1px solid #2a2f3a;border-radius:8px;padding:14px;margin-bottom:16px">
            <div style="font-size:10px;font-weight:700;color:#5a6478;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Contact Support</div>
            <div style="font-size:14px;font-weight:700;color:#00d4aa">${contact}</div>
            ${phone ? `<div style="font-size:12px;color:#9aa3b8;margin-top:4px">${phone}</div>` : ''}
          </div>
          <button onclick="document.getElementById('feature-lock-modal').remove()" style="background:#00d4aa;color:#0a0b0e;border:none;border-radius:6px;padding:10px 24px;font-weight:700;cursor:pointer;font-size:13px;width:100%">OK, Got It</button>
        </div>`;
      document.body.appendChild(el);
      el.addEventListener('click', e => { if (e.target === el) el.remove(); });
    },

    isAllowed(key) {
      return this._features[key] !== false;
    },
  };

  // ══════════════════════════════════════════════════════════════
  //  CLOUD BRIDGE
  // ══════════════════════════════════════════════════════════════
  const CloudBridge = {
    connected:       false,
    deviceToken:     null,
    deviceStatus:    null,
    shopInfo:        null,
    socket:          null,
    _syncTimer:      null,
    _heartbeatTimer: null,
    _serverUrl:      null,
    _licenseKey:     null,
    _deviceId:       null,
    _supportContact: 'evansmaina2026@gmail.com',
    _supportPhone:   '0114698986',
    _pendingPoll:    null,
    _retryTimer:     null,
    _modulesMounted: new Set(),

    // ── Device ID ────────────────────────────────────────────
    async getDeviceId() {
      if (this._deviceId) return this._deviceId;
      let id = await Settings.get('cloud_device_id', null);
      if (!id) {
        id = 'DST-' + Array.from(crypto.getRandomValues(new Uint8Array(8)))
          .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        await Settings.set('cloud_device_id', id);
      }
      this._deviceId = id;
      return id;
    },

    getDeviceInfo() {
      const ua = navigator.userAgent;
      const isAndroid = /Android/.test(ua);
      const isIOS     = /iPhone|iPad/.test(ua);
      return {
        type:    !isAndroid && !isIOS ? 'desktop' : isAndroid ? 'phone' : 'tablet',
        os:      isAndroid ? 'Android' : isIOS ? 'iOS' : 'Desktop',
        browser: ua.match(/(Chrome|Firefox|Safari|Edge)\/[\d.]+/)?.[0] || 'Browser',
      };
    },

    // ── Server list (multi-server support) ───────────────────
    getServerList() {
      try { return JSON.parse(localStorage.getItem('distore_server_list') || '[]'); } catch(e) { return []; }
    },

    saveServerList(list) {
      try { localStorage.setItem('distore_server_list', JSON.stringify(list)); } catch(e) {}
    },

    addServer(url, label) {
      const list = this.getServerList();
      const existing = list.find(s => s.url === url);
      if (!existing) list.push({ url, label: label || url, added_at: new Date().toISOString() });
      this.saveServerList(list);
    },

    // ── Register device ──────────────────────────────────────
    async registerDevice(serverUrl, licenseKey) {
      const deviceId   = await this.getDeviceId();
      const deviceInfo = this.getDeviceInfo();
      const shopName   = await Settings.get('business_name', 'Distore POS');

      let r;
      try {
        const resp = await fetch(`${serverUrl}/api/pos/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            license_key: licenseKey,
            device_id:   deviceId,
            device_name: shopName + ' — ' + deviceInfo.os,
            device_type: deviceInfo.type,
            os:          deviceInfo.os,
            browser:     deviceInfo.browser,
          }),
          signal: AbortSignal.timeout(12000),
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          const hint = text.slice(0, 200).includes('<') ? ' (server returned HTML — wrong URL?)' : ': ' + text.slice(0, 120);
          return { ok: false, msg: `Server error ${resp.status}${hint}` };
        }
        r = await resp.json();
      } catch(e) {
        return { ok: false, msg: 'Network error: ' + e.message };
      }

      if (!r.success) return { ok: false, msg: r.msg || 'Registration failed' };

      this.deviceToken  = r.data.device_token;
      this.deviceStatus = r.data.device_status;
      this.shopInfo     = r.data.shop;

      // Clear cache so next reads go to IDB
      delete Settings.cache['cloud_device_token'];
      delete Settings.cache['cloud_device_status'];

      await Settings.set('cloud_device_token',  r.data.device_token);
      await Settings.set('cloud_device_status', r.data.device_status);

      if (r.data.features)        this._applyServerFeatures(r.data.features);
      if (r.data.support_contact) this._supportContact = r.data.support_contact;
      if (r.data.support_phone)   this._supportPhone   = r.data.support_phone;

      return { ok: true, status: r.data.device_status, msg: r.data.message };
    },

    // ── Apply features from server ───────────────────────────
    _applyServerFeatures(features) {
      FeatureGate.apply(features);
    },

    // ── Main connect ─────────────────────────────────────────
    async connect() {
      const serverUrl  = await Settings.get('cloud_server_url', null);
      const licenseKey = await Settings.get('cloud_license_key', null);
      if (!serverUrl || !licenseKey) return;

      this._serverUrl  = serverUrl;
      this._licenseKey = licenseKey;

      // Add to server list
      this.addServer(serverUrl);

      this.deviceToken  = await Settings.get('cloud_device_token', null);
      this.deviceStatus = await Settings.get('cloud_device_status', null);

      // Clear stale pending poll if any
      if (this._pendingPoll) { clearInterval(this._pendingPoll); this._pendingPoll = null; }

      try {
        // Always re-register on connect — server will return existing token if device is known
        const result = await this.registerDevice(serverUrl, licenseKey);
        if (!result.ok) {
          this._setStatus('error', result.msg);
          if (result.msg.includes('DEVICE_BLOCKED')) {
            this._applyLockScreen({ message:'Device blocked by admin.', contact:this._supportContact, phone:this._supportPhone });
          } else if (result.msg.includes('DEVICE_PENDING')) {
            Toast.show('⏳ Awaiting admin approval. POS works offline.', 'warning', 5000);
            this._pendingPoll = setInterval(() => this.connect(), 30000);
          } else if (result.msg.includes('SHOP_SUSPENDED')) {
            this._applyLockScreen({ message:'Your shop is suspended.', contact:this._supportContact, phone:this._supportPhone });
          }
          return;
        }

        if (result.status === 'PENDING') {
          this._setStatus('pending', 'Awaiting admin approval');
          Toast.show('⏳ Waiting for admin approval. POS works offline.', 'warning', 5000);
          this._pendingPoll = setInterval(() => this.connect(), 30000);
          return;
        }

        if (this._pendingPoll) { clearInterval(this._pendingPoll); this._pendingPoll = null; }
        if (this._retryTimer)  { clearTimeout(this._retryTimer);   this._retryTimer  = null; }

        await this._connectSocket();
        // connected=true is now set inside auth_ok handler
        this._setStatus('online', '🌐 Connecting…');
        await this._fetchEnforcements();

        this._startSync();
        this._startHeartbeat();

        console.log('[CloudBridge] Connected:', serverUrl);

      } catch(e) {
        this._setStatus('offline', 'Offline — local mode');
        // Apply cached features in offline mode
        FeatureGate.loadCached();
        console.warn('[CloudBridge] Failed:', e.message);
        // Retry every 60s
        this._retryTimer = setTimeout(() => this.connect(), 60000);
      }
    },

    // ── Fetch enforcements from server ───────────────────────
    // This is the key function — when device comes online, it immediately
    // gets the current server state and applies all locks/features
    async _fetchEnforcements() {
      if (!this.deviceToken || !this._serverUrl) return;
      try {
        const r = await fetch(`${this._serverUrl}/api/pos/enforcements`, {
          headers: {
            'X-Device-Token': this.deviceToken,
            'X-License-Key':  this._licenseKey,
          },
          signal: AbortSignal.timeout(8000),
        }).then(r => r.json()).catch(() => null);

        if (!r || !r.success) return;
        const d = r.data;

        // 1. Apply lock if server says locked
        if (d.pos_locked) {
          this._applyLockScreen(d.lock_data || { contact: this._supportContact, phone: this._supportPhone });
          return;
        }

        // 2. Apply features
        if (d.features) this._applyServerFeatures(d.features);

        // 3. Apply support contact
        if (d.support_contact) this._supportContact = d.support_contact;
        if (d.support_phone)   this._supportPhone   = d.support_phone;

        // 4. Load and inject modules — clear set so reconnect always re-injects all
        if (d.modules && d.modules.length) {
          this._modulesMounted.clear();
          for (const mod of d.modules) this._injectModule(mod);
        }

        // 5. Apply pending patches
        if (d.patches && d.patches.length) {
          this._applyPatches(d.patches);
        }

        // 6. Process any pending commands
        if (d.commands && d.commands.length) {
          for (const cmd of d.commands) this._handleRemoteCommand(cmd.command, cmd.payload || {});
        }

        // 7. Check server switch
        if (d.new_server_url && d.new_server_url !== this._serverUrl) {
          this._switchServer(d.new_server_url, d.new_server_label);
        }

        console.log('[CloudBridge] Enforcements applied');
      } catch(e) {
        console.warn('[CloudBridge] Enforcements fetch failed:', e.message);
      }
    },

    // ── Socket.IO ────────────────────────────────────────────
    async _connectSocket() {
      // Always reload socket.io if server URL changed or not loaded yet
      if (!window.io || this._loadedSocketUrl !== this._serverUrl) {
        // Remove old socket.io script if it exists
        document.querySelectorAll('script[data-cb-socket]').forEach(s => s.remove());
        window.io = undefined;
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = `${this._serverUrl}/socket.io/socket.io.js`;
          s.setAttribute('data-cb-socket', '1');
          s.onload  = resolve;
          s.onerror = () => reject(new Error(`Failed to load socket.io from ${this._serverUrl}. Is the server running?`));
          document.head.appendChild(s);
        });
        this._loadedSocketUrl = this._serverUrl;
      }

      if (this.socket) { try { this.socket.disconnect(); } catch(e) {} this.socket = null; }

      // ALL listeners registered BEFORE the Promise resolves.
      // Registering after creates a race — auth_ok / module_push can arrive
      // before the listeners exist and be silently dropped.
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Socket timed out after 15s — server unreachable'));
        }, 15000);

        this.socket = window.io(this._serverUrl, {
          transports:   ['websocket', 'polling'],
          reconnection: false,
        });

        this.socket.on('connect', () => {
          clearTimeout(timeout);
          this.socket.emit('device_auth', {
            device_token: this.deviceToken,
            license_key:  this._licenseKey,
          });
          resolve();
        });

        this.socket.once('connect_error', (e) => {
          clearTimeout(timeout);
          reject(new Error('Socket connect error: ' + (e.message || e)));
        });

        // auth_ok = server confirmed the device is authenticated
        this.socket.on('auth_ok', (data) => {
          this.connected = true;
          this._setStatus('online', '🌐 ' + (data.shop_name || 'Connected'));
          if (data.features)        this._applyServerFeatures(data.features);
          if (data.support_contact) this._supportContact = data.support_contact;
          if (data.support_phone)   this._supportPhone   = data.support_phone;
        });

        this.socket.on('auth_error', (data) => {
          if (data.message === 'PENDING_APPROVAL') this._setStatus('pending', '⏳ Pending approval');
          else this._setStatus('error', '🔴 ' + (data.message || 'Auth error'));
        });

        this.socket.on('device_approved',  () => { Toast.show('✅ Device approved!', 'success', 4000); this.connect(); });
        this.socket.on('device_blocked',   (d) => this._applyLockScreen({ message: d.message, contact: this._supportContact, phone: this._supportPhone }));
        this.socket.on('features_updated', (d) => { if (d.features) this._applyServerFeatures(d.features); Toast.show('🔄 Features updated', 'info', 3000); });
        this.socket.on('remote_command',   (d) => this._handleRemoteCommand(d.command, d.payload || {}));
        this.socket.on('module_push',      (d) => { console.log('[CB] module_push:', d?.id); this._injectModule(d); });
        this.socket.on('patch_push',       (d) => this._applyPatches([d]));
        this.socket.on('server_switch',    (d) => this._switchServer(d.new_url, d.label));
        this.socket.on('support_update',   (d) => { if (d.contact) this._supportContact = d.contact; if (d.phone) this._supportPhone = d.phone; });

        this.socket.on('disconnect', (reason) => {
          this.connected = false;
          this._setStatus('offline', 'Offline');
          if (reason !== 'io client disconnect') {
            if (this._retryTimer) clearTimeout(this._retryTimer);
            this._retryTimer = setTimeout(() => this.connect(), 30000);
          }
        });
      });
    },

    // ── Module injector ──────────────────────────────────────
    _injectModule(mod) {
      if (!mod || !mod.id) { console.warn('[CB] _injectModule: no id', mod); return; }

      // Always clean up stale DOM first
      document.getElementById('cloud-module-'     + mod.id)?.remove();
      document.getElementById('cloud-module-css-' + mod.id)?.remove();

      if (this._modulesMounted.has(mod.id) && !mod.force_reload) {
        console.log('[CB] Module already mounted, skipping:', mod.id);
        return;
      }
      this._modulesMounted.delete(mod.id);

      try {
        const mountId = mod.mount_point || 'app';
        const mount   = document.getElementById(mountId) || document.body;

        const wrapper = document.createElement('div');
        wrapper.id    = 'cloud-module-' + mod.id;
        wrapper.setAttribute('data-module', mod.id);
        if (mod.html) wrapper.innerHTML = mod.html;

        if (mod.css) {
          const style = document.createElement('style');
          style.id = 'cloud-module-css-' + mod.id;
          style.textContent = mod.css;
          document.head.appendChild(style);
        }

        mount.appendChild(wrapper);

        if (mod.js) {
          const script = document.createElement('script');
          script.textContent = [
            '(function(){',
            'var MODULE_ID='    + JSON.stringify(mod.id)              + ';',
            'var SERVER_URL='   + JSON.stringify(this._serverUrl  || '') + ';',
            'var DEVICE_TOKEN=' + JSON.stringify(this.deviceToken || '') + ';',
            'var LICENSE_KEY='  + JSON.stringify(this._licenseKey || '') + ';',
            'async function posApi(m,p,b){return fetch(SERVER_URL+p,{method:m,headers:{"Content-Type":"application/json","X-Device-Token":DEVICE_TOKEN,"X-License-Key":LICENSE_KEY},body:b?JSON.stringify(b):undefined}).then(r=>r.json()).catch(e=>({success:false,msg:e.message}));}',
            mod.js,
            '})();',
          ].join('\n');
          document.body.appendChild(script);
        }

        this._modulesMounted.add(mod.id);
        console.log('[CB] ✅ Module injected:', mod.id, '→ #' + mountId);
        Toast.show('📦 Module: ' + (mod.name || mod.id), 'info', 2000);
      } catch(e) {
        console.error('[CB] Module inject error:', mod.id, e);
      }
    },

    // Remove a module
    _removeModule(moduleId) {
      document.getElementById('cloud-module-' + moduleId)?.remove();
      document.getElementById('cloud-module-css-' + moduleId)?.remove();
      this._modulesMounted.delete(moduleId);
    },

    // ── Patch system ─────────────────────────────────────────
    _applyPatches(patches) {
      for (const patch of patches) {
        try {
          // CSS patch
          if (patch.type === 'css') {
            let el = document.getElementById('cloud-patch-css-' + patch.id);
            if (!el) { el = document.createElement('style'); el.id = 'cloud-patch-css-' + patch.id; document.head.appendChild(el); }
            el.textContent = patch.content;
          }
          // JS patch
          if (patch.type === 'js') {
            const script = document.createElement('script');
            script.textContent = patch.content;
            document.body.appendChild(script);
          }
          // HTML patch — replace or insert by selector
          if (patch.type === 'html' && patch.selector) {
            const target = document.querySelector(patch.selector);
            if (target) {
              if (patch.action === 'replace')     target.outerHTML = patch.content;
              else if (patch.action === 'append')  target.insertAdjacentHTML('beforeend', patch.content);
              else if (patch.action === 'prepend') target.insertAdjacentHTML('afterbegin', patch.content);
            }
          }
          console.log('[CloudBridge] Patch applied:', patch.id, patch.type);
        } catch(e) {
          console.error('[CloudBridge] Patch error:', patch.id, e.message);
        }
      }
    },

    // ── Remote commands ──────────────────────────────────────
    _handleRemoteCommand(command, payload) {
      console.log('[CloudBridge] Command:', command, payload);

      const lockAndReload = (msg, contact, phone) => {
        this._applyLockScreen({ message: msg, contact: contact || this._supportContact, phone: phone || this._supportPhone, locked_at: new Date().toISOString() });
      };

      switch (command) {
        case 'LOCK_POS':
          Toast.show('🔒 POS being locked by administrator...', 'warning', 2000);
          setTimeout(() => lockAndReload(payload.message, payload.contact, payload.phone), 1500);
          break;

        case 'UNLOCK_POS':
          localStorage.removeItem('distore_pos_lock');
          Toast.show('🔓 POS unlocked!', 'success', 3000);
          setTimeout(() => window.location.reload(), 2000);
          break;

        case 'FORCE_LOGOUT':
          Toast.show('🚪 Logged out by admin', 'warning', 2000);
          setTimeout(() => { if (typeof App !== 'undefined') App.confirmLogout(); else window.location.reload(); }, 2000);
          break;

        case 'RELOAD_APP':
          Toast.show('🔄 Reloading...', 'info', 1500);
          setTimeout(() => window.location.reload(), 1500);
          break;

        case 'MESSAGE': {
          const msg = payload.message || '';
          Toast.show('📢 Admin: ' + msg, 'info', 8000);
          if (payload.important) this._showAdminMessage(msg);
          break;
        }

        case 'SHOP_SUSPENDED':
          setTimeout(() => lockAndReload(payload.message, payload.contact, payload.phone), 1500);
          break;

        case 'INJECT_MODULE':
          this._injectModule(payload);
          break;

        case 'REMOVE_MODULE':
          this._removeModule(payload.module_id);
          break;

        case 'APPLY_PATCH':
          this._applyPatches([payload]);
          break;

        case 'SWITCH_SERVER':
          this._switchServer(payload.new_url, payload.label);
          break;

        case 'APPLY_FEATURES':
          if (payload.features) this._applyServerFeatures(payload.features);
          break;

        case 'UPDATE_SUPPORT':
          if (payload.contact) this._supportContact = payload.contact;
          if (payload.phone)   this._supportPhone   = payload.phone;
          break;

        default:
          console.warn('[CloudBridge] Unknown command:', command);
      }
    },

    // ── Server switch ────────────────────────────────────────
    async _switchServer(newUrl, label) {
      if (!newUrl || newUrl === this._serverUrl) return;
      console.log('[CloudBridge] Switching server to:', newUrl);
      Toast.show('🔄 Switching to new server...', 'info', 3000);

      // Save new server
      await Settings.set('cloud_server_url', newUrl);
      this.addServer(newUrl, label || newUrl);

      // Disconnect from old server
      if (this.socket) this.socket.disconnect();
      if (this._syncTimer)      clearInterval(this._syncTimer);
      if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);

      this._serverUrl = newUrl;

      // Reconnect to new server
      setTimeout(() => this.connect(), 1000);
    },

    // ── Lock screen ──────────────────────────────────────────
    _applyLockScreen(data) {
      // Save to localStorage (persists across reloads)
      const lockData = {
        locked:     true,
        locked_at:  data.locked_at || new Date().toISOString(),
        message:    data.message   || 'This POS has been locked by the administrator.',
        contact:    data.contact   || this._supportContact,
        phone:      data.phone     || this._supportPhone,
      };
      try { localStorage.setItem('distore_pos_lock', JSON.stringify(lockData)); } catch(e) {}

      // Apply immediately without reload
      document.body.innerHTML = `
        <div style="position:fixed;inset:0;z-index:999999;background:#0a0b0e;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:'Segoe UI',system-ui,sans-serif;text-align:center;padding:30px">
          <div style="font-size:72px;margin-bottom:14px">🔒</div>
          <div style="font-size:26px;font-weight:900;color:#ff4a6e;letter-spacing:-1px;margin-bottom:6px">POS LOCKED</div>
          <div style="font-size:14px;color:#e8eaf0;font-weight:600;margin-bottom:6px">This device has been locked by the administrator.</div>
          <div style="font-size:13px;color:#9aa3b8;margin-bottom:28px;max-width:380px;line-height:1.7">${lockData.message}</div>
          <div style="background:#111318;border:1px solid #2a2f3a;border-radius:12px;padding:18px 28px;margin-bottom:20px;max-width:320px">
            <div style="font-size:10px;font-weight:700;color:#5a6478;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Contact Support</div>
            <div style="font-size:15px;font-weight:700;color:#00d4aa">${lockData.contact}</div>
            ${lockData.phone ? `<div style="font-size:13px;color:#9aa3b8;margin-top:4px">${lockData.phone}</div>` : ''}
          </div>
          <div style="font-size:11px;color:#5a6478">Locked: ${new Date(lockData.locked_at).toLocaleString()}</div>
          <div style="margin-top:24px"><div style="font-size:22px;font-weight:900;color:#00d4aa;letter-spacing:-1px">DISTORE</div><div style="font-size:9px;color:#5a6478;letter-spacing:2px;text-transform:uppercase">by Dilly Solutions</div></div>
        </div>`;
    },

    _showAdminMessage(msg) {
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';
      ov.innerHTML = `
        <div style="background:#111318;border:1px solid #ffd166;border-radius:12px;padding:24px;max-width:380px;text-align:center">
          <div style="font-size:28px;margin-bottom:10px">📢</div>
          <div style="font-size:15px;font-weight:800;color:#ffd166;margin-bottom:12px">Message from Administrator</div>
          <div style="font-size:13px;color:#e8eaf0;line-height:1.7;margin-bottom:20px">${msg}</div>
          <button onclick="this.closest('div').parentNode.remove()" style="background:#ffd166;color:#0a0b0e;border:none;border-radius:6px;padding:10px 24px;font-weight:700;cursor:pointer;width:100%">OK, Got It</button>
        </div>`;
      ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
      document.body.appendChild(ov);
    },

    // ── Status indicator ─────────────────────────────────────
    _setStatus(state, label) {
      // POS has two #ct-status-sync elements (phone + desktop layout).
      // getElementById only finds the first — which may be the hidden one.
      const icons  = { online:'🟢', offline:'⚪', pending:'🟡', error:'🔴' };
      const colors = { online:'var(--accent,#00d4aa)', offline:'var(--text3,#5a6478)', pending:'var(--yellow,#ffd166)', error:'var(--red,#ff4a6e)' };
      const txt = (icons[state] || '⚪') + ' ' + label;
      document.querySelectorAll('#ct-status-sync').forEach(el => {
        el.textContent = txt;
        el.style.color  = colors[state] || '';
      });
    },

    // ── Cloud sync ───────────────────────────────────────────
    async syncToCloud() {
      if (!this.connected || !this.deviceToken || !this._serverUrl) return;
      const STORES = ['invoices','invoice_items','products','customers','stock_movements','audit_logs','expenses'];
      const stores = {};
      for (const s of STORES) {
        try { stores[s] = await (typeof idb !== 'undefined' ? idb.getAll(s) : []); } catch(e) { stores[s] = []; }
      }
      try {
        await fetch(`${this._serverUrl}/api/pos/sync/push`, {
          method:  'POST',
          headers: { 'Content-Type':'application/json', 'X-Device-Token':this.deviceToken, 'X-License-Key':this._licenseKey },
          body:    JSON.stringify({ stores }),
          signal:  AbortSignal.timeout(30000),
        });
        await Settings.set('cloud_last_sync', new Date().toISOString());
      } catch(e) {}
    },

    // ── Heartbeat ────────────────────────────────────────────
    async _sendHeartbeat() {
      if (!this.connected || !this.deviceToken || !this._serverUrl) return;
      try {
        const r = await fetch(`${this._serverUrl}/api/pos/heartbeat`, {
          method:  'POST',
          headers: { 'Content-Type':'application/json', 'X-Device-Token':this.deviceToken, 'X-License-Key':this._licenseKey },
          body:    JSON.stringify({ pos_user: Auth.currentUser?.username || null }),
          signal:  AbortSignal.timeout(5000),
        }).then(r => r.json()).catch(() => null);

        if (r?.success && r.data?.commands?.length) {
          for (const cmd of r.data.commands) this._handleRemoteCommand(cmd.command, cmd.payload);
        }
      } catch(e) {}
    },

    _startSync()      { if (this._syncTimer) clearInterval(this._syncTimer); this.syncToCloud(); this._syncTimer = setInterval(() => this.syncToCloud(), 5*60*1000); },
    _startHeartbeat() { if (this._heartbeatTimer) clearInterval(this._heartbeatTimer); this._heartbeatTimer = setInterval(() => this._sendHeartbeat(), 60*1000); },

    disconnect() {
      if (this.socket)          this.socket.disconnect();
      if (this._syncTimer)      clearInterval(this._syncTimer);
      if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
      if (this._pendingPoll)    clearInterval(this._pendingPoll);
      if (this._retryTimer)     clearTimeout(this._retryTimer);
      this.connected = false;
      Settings.set('cloud_server_url', null);
      Settings.set('cloud_license_key', null);
      Settings.set('cloud_device_token', null);
      this._setStatus('offline', '⚪ Offline');
      Toast.show('Disconnected from cloud', 'info');
    },

    // ── Settings section renderer ────────────────────────────
    async renderSettings(container) {
      const serverUrl  = await Settings.get('cloud_server_url', '');
      const licenseKey = await Settings.get('cloud_license_key', '');
      const apiKey     = await Settings.get('cloud_api_key', '');
      const deviceId   = await this.getDeviceId();
      const lastSync   = await Settings.get('cloud_last_sync', null);
      const devStatus  = await Settings.get('cloud_device_status', '');
      const isConn     = this.connected;
      const serverList = this.getServerList();

      container.innerHTML = `
        <div class="card">
          <div class="card-header">
            <div><div class="card-title">🌐 Distore Cloud Server</div><div class="card-sub">Connect this POS to your Distore Master Server</div></div>
            <span style="background:${isConn?'rgba(0,212,170,.15)':'rgba(90,100,120,.15)'};color:${isConn?'var(--accent)':'var(--text3)'};border-radius:20px;padding:3px 10px;font-size:11px;font-weight:700">${isConn?'🟢 Online':devStatus==='PENDING'?'⏳ Pending':'⚪ Offline'}</span>
          </div>

          ${isConn ? `<div class="alert alert-success" style="margin-bottom:14px;font-size:12px">✅ Connected to <b>${serverUrl}</b>${this.shopInfo?' · '+this.shopInfo.name:''}${lastSync?'<br>Last sync: '+new Date(lastSync).toLocaleString():''}</div>` : ''}

          <div class="form-group" style="margin-bottom:10px">
            <label class="form-label">Server URL</label>
            <div style="display:flex;gap:8px">
              <input class="form-control" id="cs-server-url" value="${serverUrl}" placeholder="https://your-server.onrender.com" style="font-family:var(--font-mono);flex:1">
              ${serverList.length > 1 ? `<button class="btn btn-secondary btn-sm" onclick="CloudBridge._showServerPicker()" title="Saved servers">📋</button>` : ''}
            </div>
          </div>
          <div class="form-group" style="margin-bottom:10px">
            <label class="form-label">License Key</label>
            <input class="form-control" id="cs-license-key" value="${licenseKey}" placeholder="DST-XXXXXXXXXXXX" style="font-family:var(--font-mono);text-transform:uppercase" oninput="this.value=this.value.toUpperCase()">
          </div>
          <div class="form-group" style="margin-bottom:16px">
            <label class="form-label">API Key</label>
            <div style="display:flex;gap:8px">
              <input class="form-control" id="cs-api-key" type="password" value="${apiKey}" placeholder="dak_..." style="font-family:var(--font-mono);flex:1">
              <button class="btn btn-secondary btn-sm" onclick="const f=document.getElementById('cs-api-key');f.type=f.type==='password'?'text':'password'" style="width:40px">👁</button>
            </div>
          </div>

          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
            <button class="btn btn-primary" onclick="CloudBridge._saveAndConnect(document.getElementById('cs-save-label')?.value?.trim())">💾 Save & Connect</button>
            <button class="btn btn-secondary btn-sm" onclick="CloudBridge._testConnection()">🧪 Test</button>
            ${isConn ? `<button class="btn btn-secondary btn-sm" onclick="CloudBridge.syncToCloud();Toast.show('☁️ Syncing...','info')">☁️ Sync Now</button>` : ''}
            ${isConn ? `<button class="btn btn-danger btn-sm" onclick="CloudBridge.disconnect()">⏏️ Disconnect</button>` : ''}
          </div>

          <div id="cs-status"></div>

          <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:12px">
            <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">This Device</div>
            <div style="font-size:11px;color:var(--text2)">ID: <code style="color:var(--accent)">${deviceId}</code></div>
            <div style="font-size:11px;color:var(--text2);margin-top:3px">Status: <span style="color:${devStatus==='APPROVED'?'var(--accent)':'var(--text3)'}">
              ${devStatus||'Not registered'}</span></div>
          </div>

          ${serverList.length > 0 ? `
          <div style="margin-top:12px">
            <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Saved Servers</div>
            ${serverList.map((s,i) => `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(42,47,58,.4)">
              <div style="flex:1;font-size:11px;font-family:var(--font-mono);color:${s.url===serverUrl?'var(--accent)':'var(--text3)'}">${s.url}</div>
              ${s.url !== serverUrl ? `<button class="btn btn-secondary btn-sm" style="font-size:10px;padding:3px 8px" onclick="CloudBridge._switchServer('${s.url}','')">Switch</button>` : '<span style="font-size:10px;color:var(--accent)">Active</span>'}
              <button class="btn btn-danger btn-sm" style="font-size:10px;padding:3px 6px" onclick="CloudBridge._removeServerFromList(${i})">✕</button>
            </div>`).join('')}
          </div>` : ''}

          <div class="alert alert-info" style="margin-top:14px;font-size:11px;line-height:1.8">
            <b>How to connect:</b><br>
            1. Deploy <code>distore-server.js</code> on Render/Railway/etc<br>
            2. Master Panel → Shops → Create Shop → copy License Key<br>
            3. Master Panel → API Keys → Create → copy API Key<br>
            4. Enter all three above → Save & Connect<br>
            5. Approve this device in Master Panel → Devices
          </div>
        </div>`;
    },

    async _saveAndConnect(label) {
      const url    = document.getElementById('cs-server-url')?.value?.trim().replace(/\/$/, '');
      const key    = document.getElementById('cs-license-key')?.value?.trim();
      const apiKey = document.getElementById('cs-api-key')?.value?.trim();
      const el     = document.getElementById('cs-status');
      if (!url || !key) { Toast.show('Server URL and License Key required', 'error'); return; }

      const setStatus = (html) => { if (el) el.innerHTML = html; };
      setStatus('<div style="color:var(--text3);font-size:12px">⏳ Step 1/3 — Checking server…</div>');

      // ── Step 1: Reachability probe ────────────────────────────
      try {
        const probe = await fetch(url + '/api/info', { signal: AbortSignal.timeout(10000) });
        if (!probe.ok) {
          const body = await probe.text().catch(() => '');
          const isHtml = body.trim().startsWith('<');
          setStatus(`<div class="alert alert-error" style="font-size:12px">
            ❌ Server returned HTTP ${probe.status}${isHtml ? ' — URL may be wrong (got HTML page)' : ''}<br>
            <small>Check URL — no trailing slash, no /api suffix.<br>Example: <code>https://your-app.onrender.com</code></small>
          </div>`);
          return;
        }
        const info = await probe.json().catch(() => null);
        if (info && !info.success) {
          setStatus('<div class="alert alert-error" style="font-size:12px">❌ Server responded but returned an error</div>');
          return;
        }
      } catch(e) {
        setStatus(`<div class="alert alert-error" style="font-size:12px">
          ❌ Cannot reach server<br><small>${e.message}</small><br>
          <small style="opacity:.7">Server may be sleeping — wait 30s and try again, or check the URL.</small>
        </div>`);
        return;
      }

      setStatus('<div style="color:var(--text3);font-size:12px">⏳ Step 2/3 — Registering device…</div>');

      // Clear stale values from Settings cache before saving new ones
      delete Settings.cache['cloud_server_url'];
      delete Settings.cache['cloud_license_key'];
      delete Settings.cache['cloud_api_key'];
      delete Settings.cache['cloud_device_token'];
      delete Settings.cache['cloud_device_status'];

      await Settings.set('cloud_server_url',  url);
      await Settings.set('cloud_license_key', key);
      if (apiKey) await Settings.set('cloud_api_key', apiKey);
      await Settings.set('cloud_device_token',  null);
      await Settings.set('cloud_device_status', null);

      this.deviceToken  = null;
      this.deviceStatus = null;

      // Tear down any existing connection
      try { if (this.socket) { this.socket.disconnect(); this.socket = null; } } catch(e) {}
      if (this._syncTimer)      { clearInterval(this._syncTimer);      this._syncTimer = null; }
      if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
      if (this._pendingPoll)    { clearInterval(this._pendingPoll);    this._pendingPoll = null; }
      if (this._retryTimer)     { clearTimeout(this._retryTimer);      this._retryTimer = null; }
      this.connected  = false;
      this._serverUrl  = url;
      this._licenseKey = key;
      this.addServer(url, label || url);

      // ── Step 2: Register device ───────────────────────────────
      const result = await this.registerDevice(url, key);
      if (!result.ok) {
        setStatus(`<div class="alert alert-error" style="font-size:12px">❌ Registration failed: ${result.msg}</div>`);
        return;
      }

      if (result.status === 'PENDING') {
        setStatus(`<div class="alert alert-warning" style="font-size:12px">
          ⏳ Device registered — waiting for admin approval<br>
          <small>Go to Admin Panel → Devices and approve this device.<br>POS works fully offline in the meantime.</small>
        </div>`);
        this._pendingPoll = setInterval(() => this.connect(), 30000);
        return;
      }

      // ── Step 3: APPROVED — connect socket ────────────────────
      setStatus('<div style="color:var(--text3);font-size:12px">⏳ Step 3/3 — Connecting socket…</div>');
      try {
        await this._connectSocket();
        // connected=true set inside auth_ok
        this._startSync();
        this._startHeartbeat();
        await this._fetchEnforcements();
        setStatus(`<div class="alert alert-success" style="font-size:12px">
          ✅ Connected to cloud!${this.shopInfo ? ' · <b>' + this.shopInfo.name + '</b>' : ''}<br>
          <small>Real-time sync active. Features applied from server.</small>
        </div>`);
        Toast.show('☁️ Cloud connected!', 'success', 3000);
      } catch(e) {
        setStatus(`<div class="alert alert-warning" style="font-size:12px">
          ⚠️ Registered but socket failed: ${e.message}<br>
          <small>POS works offline. Will auto-retry in 30s.</small>
        </div>`);
        this._retryTimer = setTimeout(() => this.connect(), 30000);
      }

      // Refresh the settings panel after a moment
      setTimeout(() => {
        const c = document.getElementById('cloud-settings-container') || document.querySelector('.cloud-settings-container');
        if (c) this.renderSettings(c);
      }, 2500);
    },

    async _testConnection() {
      const url = document.getElementById('cs-server-url')?.value?.trim().replace(/\/$/, '');
      const el  = document.getElementById('cs-status');
      if (!url) { Toast.show('Enter server URL first', 'error'); return; }
      if (el) el.innerHTML = '<div style="color:var(--text3);font-size:12px">⏳ Testing...</div>';
      try {
        const resp = await fetch(url + '/api/info', { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) {
          if (el) el.innerHTML = `<div class="alert alert-error" style="font-size:12px">❌ Server returned HTTP ${resp.status}<br><small>Check the URL — no trailing slash, e.g. <code>https://your-app.onrender.com</code></small></div>`;
          return;
        }
        const r = await resp.json();
        if (r.success) {
          if (el) el.innerHTML = `<div class="alert alert-success" style="font-size:12px">✅ Server reachable!<br>Version: ${r.data.server||r.data.version||'?'} · Shops: ${r.data.shops} · Devices: ${r.data.devices}<br>Time: ${new Date(r.data.time).toLocaleString()}</div>`;
        } else {
          if (el) el.innerHTML = '<div class="alert alert-error" style="font-size:12px">⚠️ Server responded but returned an error</div>';
        }
      } catch(e) {
        if (el) el.innerHTML = `<div class="alert alert-error" style="font-size:12px">❌ Cannot reach server<br><small>${e.message}</small></div>`;
      }
    },

    _removeServerFromList(index) {
      const list = this.getServerList();
      list.splice(index, 1);
      this.saveServerList(list);
      // Re-render settings
      const container = document.getElementById('cloud-settings-container') || document.querySelector('.cloud-settings-container');
      if (container) this.renderSettings(container);
    },

    _showServerPicker() {
      const list = this.getServerList();
      const existing = document.getElementById('server-picker-modal');
      if (existing) existing.remove();
      const ov = document.createElement('div');
      ov.id = 'server-picker-modal';
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';
      ov.innerHTML = `
        <div style="background:#111318;border:1px solid #2a2f3a;border-radius:12px;padding:20px;max-width:400px;width:100%">
          <div style="font-size:15px;font-weight:800;margin-bottom:14px;color:#e8eaf0">Saved Servers</div>
          ${list.map(s => `<div style="display:flex;align-items:center;gap:10px;padding:10px;background:#181b22;border-radius:8px;margin-bottom:6px;cursor:pointer" onclick="document.getElementById('cs-server-url').value='${s.url}';document.getElementById('server-picker-modal').remove()">
            <div style="flex:1;font-size:12px;font-family:monospace;color:#9aa3b8">${s.url}</div>
            <div style="font-size:10px;color:#5a6478">${s.added_at?new Date(s.added_at).toLocaleDateString():''}</div>
          </div>`).join('')}
          <button onclick="document.getElementById('server-picker-modal').remove()" style="background:#181b22;border:1px solid #2a2f3a;color:#9aa3b8;padding:8px 16px;border-radius:6px;cursor:pointer;width:100%;margin-top:8px">Cancel</button>
        </div>`;
      ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
      document.body.appendChild(ov);
    },
  };

  // ── Expose globally ──────────────────────────────────────────
  window.CloudBridge  = CloudBridge;
  window.FeatureGate  = FeatureGate;

  // ══════════════════════════════════════════════════════════════
  //  BOOT
  // ══════════════════════════════════════════════════════════════
  async function bootBridge() {
    // 1. Apply cached features immediately (offline enforcement)
    FeatureGate.loadCached();

    // 2. Auto-connect — but only after idb is truly ready
    //    Wait for Settings.get to actually return a value (not throw)
    const _waitForIdb = () => new Promise(resolve => {
      const check = async () => {
        try {
          await Settings.get('_idb_ready_check', null);
          resolve();
        } catch(e) {
          setTimeout(check, 300);
        }
      };
      check();
    });

    _waitForIdb().then(() => {
      // Small extra delay so the POS UI is fully painted
      setTimeout(() => CloudBridge.connect(), 1500);
    });

    // 3. Patch Auth.login to notify server
    const _origLogin = Auth.login?.bind(Auth);
    if (_origLogin) {
      Auth.login = async function (...args) {
        const result = await _origLogin(...args);
        if (result && CloudBridge.connected && CloudBridge.deviceToken) {
          fetch(`${CloudBridge._serverUrl}/api/pos/auth`, {
            method:  'POST',
            headers: { 'Content-Type':'application/json', 'X-Device-Token':CloudBridge.deviceToken, 'X-License-Key':CloudBridge._licenseKey },
            body:    JSON.stringify({ username: Auth.currentUser?.username, role: Auth.currentUser?.role }),
          }).catch(() => {});
        }
        return result;
      };
    }

    // 4. Inject Cloud Server settings section
    injectSettings();

    console.log('[CloudBridge] Boot complete ✅');
  }

  function injectSettings() {
    waitFor(() => typeof SettingsModule !== 'undefined', () => {
      const _orig = SettingsModule.showSection?.bind(SettingsModule);
      if (_orig) {
        SettingsModule.showSection = async function (key, container) {
          if (key === 'cloud_server') {
            container.id = 'cloud-settings-container';
            container.className = (container.className || '') + ' cloud-settings-container';
            await CloudBridge.renderSettings(container);
            return;
          }
          await _orig.call(SettingsModule, key, container);
        };
      }

      // Add nav item
      setTimeout(() => {
        const nav = document.querySelector('#sett-sidebar, #settings-nav, .settings-sidebar');
        if (nav && !document.getElementById('sett-nav-cloud')) {
          const btn = document.createElement('div');
          btn.id = 'sett-nav-cloud';
          btn.className = 'sb-item';
          btn.innerHTML = `<span class="sb-icon">🌐</span><span>Cloud Server</span>${CloudBridge.connected?'<span style="width:6px;height:6px;border-radius:50%;background:var(--accent);margin-left:auto;display:inline-block"></span>':''}`;
          btn.onclick = () => {
            const content = document.querySelector('#sett-content, #settings-content');
            if (content) {
              content.id = 'cloud-settings-container';
              content.className = (content.className || '') + ' cloud-settings-container';
              CloudBridge.renderSettings(content);
            }
            document.querySelectorAll('.sb-item').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          };
          nav.appendChild(btn);
        }
      }, 500);
    }, 800);
  }

})();
