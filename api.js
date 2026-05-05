(function () {
  const isLocalHost = ['localhost', '127.0.0.1', ''].includes(window.location.hostname);
  const isVercel = window.location.hostname.endsWith('.vercel.app');
  const apiBase = window.EMOBOX_API_BASE || (window.location.protocol === 'file:' ? 'http://localhost:3000' : '');
  const apiEnabled = Boolean(window.EMOBOX_API_BASE) || (isLocalHost && !isVercel);

  function toNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function compactUser(user) {
    if (!user) return null;
    return {
      name: user.name || user.fullName || 'Khach Hang',
      email: user.email || '',
      phone: user.phone || '',
      address: user.address || '',
      plan: user.plan || 'none',
      pendingPlan: user.pendingPlan || null,
      balance: toNumber(user.balance, 0),
      registeredAt: user.registeredAt || null
    };
  }

  async function request(path, payload) {
    if (!apiEnabled) {
      return { ok: false, skipped: true };
    }

    try {
      const response = await fetch(apiBase + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      return data;
    } catch (err) {
      console.warn('[EmoBox SQL] Khong luu duoc xuong SQL:', err.message);
      return { ok: false, error: err.message };
    }
  }

  window.EmoBoxApi = {
    upsertUser(user, extra) {
      return request('/api/users/upsert', { user: Object.assign(compactUser(user) || {}, extra || {}) });
    },
    loginUser(email, password) {
      return request('/api/users/login', { email, password });
    },
    activateSubscription(user, planCode, plan, paymentMethod) {
      return request('/api/subscriptions/activate', {
        user: compactUser(user),
        planCode,
        plan,
        paymentMethod: paymentMethod || 'card'
      });
    },
    recordWalletDeposit(user, amount) {
      return request('/api/wallet/deposit', {
        user: compactUser(user),
        amount: toNumber(amount, 0),
        paymentMethod: 'bank'
      });
    },
    recordWalletWithdrawal(user, amount, bankInfo) {
      return request('/api/wallet/withdraw', {
        user: compactUser(user),
        amount: toNumber(amount, 0),
        paymentMethod: 'bank_transfer',
        bankInfo: bankInfo || {}
      });
    },
    saveGiftSchedule(eventData, user, paymentMethod) {
      return request('/api/gift-schedules', {
        user: compactUser(user),
        event: eventData,
        paymentMethod: paymentMethod || 'bank'
      });
    },
    deleteGiftSchedule(localEventId, user) {
      return request('/api/gift-schedules/delete', {
        user: compactUser(user),
        localEventId
      });
    },
    saveOrder(order, user) {
      return request('/api/orders', {
        user: compactUser(user),
        order
      });
    }
  };
})();
