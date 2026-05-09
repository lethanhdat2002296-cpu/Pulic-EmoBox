(function () {
  const isLocalHost = ['localhost', '127.0.0.1', ''].includes(window.location.hostname);
  const isVercel = window.location.hostname.endsWith('.vercel.app');
  const apiBase = window.EMOBOX_API_BASE || (window.location.protocol === 'file:' ? 'http://localhost:3000' : '');
  // Enable API if we have an explicit base, OR if we are on localhost, OR if we are on Vercel.
  const apiEnabled = Boolean(window.EMOBOX_API_BASE) || isLocalHost || isVercel;

  function toNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function compactUser(user) {
    if (!user) return null;
    return {
      userId: user.userId || user.user_id || null,
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
      const response = await fetch(apiBase + '/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ route: path }, payload || {}))
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

  async function directRequest(path, payload) {
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
      console.warn('[EmoBox SQL] Khong goi duoc API:', err.message);
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
    activateSubscription(user, planCode, plan, paymentMethod, paymentInfo) {
      return request('/api/subscriptions/activate', {
        user: compactUser(user),
        planCode,
        plan,
        paymentMethod: paymentMethod || 'bank_transfer',
        paymentReference: paymentInfo && paymentInfo.paymentReference || '',
        paymentProofUrl: paymentInfo && paymentInfo.paymentProofUrl || '',
        bankTransferNote: paymentInfo && paymentInfo.bankTransferNote || ''
      });
    },
    recordWalletDeposit(user, amount, bankInfo) {
      return request('/api/wallet/deposit', {
        user: compactUser(user),
        amount: toNumber(amount, 0),
        paymentMethod: 'bank_transfer',
        bankInfo: bankInfo || {},
        paymentReference: bankInfo && bankInfo.paymentReference || '',
        paymentProofUrl: bankInfo && bankInfo.paymentProofUrl || '',
        bankTransferNote: bankInfo && bankInfo.bankTransferNote || ''
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
    listGiftSchedules(user) {
      return request('/api/gift-schedules/list', {
        user: compactUser(user)
      });
    },
    deleteGiftSchedule(localEventId, user) {
      return request('/api/gift-schedules/delete', {
        user: compactUser(user),
        localEventId
      });
    },
    getWalletHistory(user) {
      return request('/api/wallet/history', {
        user: compactUser(user)
      });
    },
    getBankCard(user) {
      return request('/api/bank-card/get', {
        user: compactUser(user)
      });
    },
    saveBankCard(user, card) {
      return request('/api/bank-card/save', {
        user: compactUser(user),
        card
      });
    },
    sendRegistrationEmail(user) {
      return request('/api/email/registration', {
        user: compactUser(user)
      });
    },
    sendGiftScheduleEmail(eventData, user, paymentMethod) {
      return request('/api/email/gift-schedule', {
        user: compactUser(user),
        event: eventData,
        paymentMethod: paymentMethod || 'bank'
      });
    },
    saveOrder(order, user) {
      return request('/api/orders', {
        user: compactUser(user),
        order
      });
    },
    validateVoucher(code, user, subtotal) {
      return request('/api/vouchers/validate', {
        user: compactUser(user),
        code,
        subtotal: toNumber(subtotal, 0)
      });
    },
    listOrders(user) {
      return request('/api/orders/history', {
        user: compactUser(user)
      });
    },
    trackOrder(orderCode, email, phone, user) {
      return request('/api/orders/track', {
        user: compactUser(user),
        orderCode,
        email: email || '',
        phone: phone || ''
      });
    },
    confirmBankTransfer(orderCode, payload, user) {
      return request('/api/orders/confirm-bank-transfer', Object.assign({
        user: compactUser(user),
        orderCode
      }, payload || {}));
    },
    listPaymentReviews(secret) {
      return directRequest('/api/payments/review/list', {
        secret
      });
    },
    decidePaymentReview(secret, payload) {
      return directRequest('/api/payments/review/decide', Object.assign({
        secret
      }, payload || {}));
    },
    sendContactMessage(message) {
      return request('/api/contact', {
        message
      });
    },
    listRecipients(user) {
      return request('/api/recipients/list', {
        user: compactUser(user)
      });
    }
  };
})();
