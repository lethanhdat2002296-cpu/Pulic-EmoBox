let transporter;
let nodemailer;

function getNodemailer() {
  if (!nodemailer) {
    nodemailer = require('nodemailer');
  }
  return nodemailer;
}

function redact(value) {
  if (!value) return '';
  const text = String(value);
  if (text.length <= 4) return '****';
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function getConfig() {
  const user = process.env.EMAIL_USER || process.env.GMAIL_USER || process.env.SMTP_USER;
  const pass = process.env.EMAIL_APP_PASSWORD || process.env.GMAIL_APP_PASSWORD || process.env.EMAIL_PASS || process.env.SMTP_PASS;
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);

  return {
    user,
    pass: pass ? String(pass).replace(/\s/g, '') : '',
    host,
    port,
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
    from: process.env.EMAIL_FROM || (user ? `EmoBox <${user}>` : ''),
    adminTo: process.env.EMAIL_ADMIN_TO || user
  };
}

function isEmailConfigured() {
  const config = getConfig();
  return Boolean(config.user && config.pass && config.from);
}

function getEmailStatus() {
  const config = getConfig();
  return {
    configured: isEmailConfigured(),
    hasUser: Boolean(config.user),
    hasPassword: Boolean(config.pass),
    hasFrom: Boolean(config.from),
    user: redact(config.user),
    from: config.from ? config.from.replace(/<([^>]+)>/, (_, email) => `<${redact(email)}>`): '',
    adminTo: redact(config.adminTo),
    provider: config.host ? 'smtp' : 'gmail',
    host: config.host || 'gmail',
    port: config.host ? config.port : 465
  };
}

function missingEmailConfigResult() {
  const config = getConfig();
  return {
    sent: false,
    skipped: true,
    reason: 'Chưa cấu hình email',
    status: {
      configured: false,
      hasUser: Boolean(config.user),
      hasPassword: Boolean(config.pass),
      hasFrom: Boolean(config.from),
      user: redact(config.user),
      from: config.from ? config.from.replace(/<([^>]+)>/, (_, email) => `<${redact(email)}>`): '',
      adminTo: redact(config.adminTo)
    }
  };
}

function getTransporter() {
  if (transporter) return transporter;

  const config = getConfig();
  if (!isEmailConfigured()) {
    throw new Error('Missing EMAIL_USER or EMAIL_APP_PASSWORD environment variable');
  }

  const mailer = getNodemailer();

  transporter = mailer.createTransport(config.host ? {
    host: config.host,
    port: config.port,
    secure: config.secure,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 7000,
    auth: {
      user: config.user,
      pass: config.pass
    }
  } : {
    service: 'gmail',
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 7000,
    auth: {
      user: config.user,
      pass: config.pass
    }
  });

  return transporter;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(value) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0
  }).format(number);
}

function methodLabel(value) {
  const labels = {
    card: 'Thẻ ngân hàng',
    bank: 'Chuyển khoản',
    wallet: 'Ví EmoBox',
    cod: 'Thanh toán khi nhận hàng'
  };
  return labels[value] || value || 'Không rõ';
}

function planLabel(value) {
  const labels = {
    none: 'Thành viên thường',
    '3-months': 'Gói 3 tháng',
    '6-months': 'Gói 6 tháng',
    '12-months': 'Gói 12 tháng'
  };
  return labels[value] || value || 'Thành viên thường';
}

function dateLabel(value) {
  if (!value) return 'Chưa có ngày';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(date);
}

function emailShell(title, content) {
  return `
    <div style="margin:0;background:#f6f4f1;padding:24px;font-family:Arial,sans-serif;color:#24201d">
      <div style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:12px;overflow:hidden">
        <div style="padding:24px;background:#24201d;color:#fff">
          <h1 style="margin:0;font-size:22px">EmoBox</h1>
          <p style="margin:8px 0 0">${escapeHtml(title)}</p>
        </div>
        <div style="padding:24px">${content}</div>
      </div>
    </div>
  `;
}

async function sendMessages(messages) {
  if (!isEmailConfigured()) {
    return missingEmailConfigResult();
  }

  const validMessages = messages.filter(message => message && message.to);
  if (!validMessages.length) {
    return { sent: false, skipped: true, reason: 'Không có email người nhận' };
  }

  const mailer = getTransporter();
  const results = await Promise.allSettled(validMessages.map(message => mailer.sendMail(message)));
  const sent = results.filter(result => result.status === 'fulfilled').length;
  const failed = results.length - sent;
  const errors = results
    .filter(result => result.status === 'rejected')
    .map(result => ({
      code: result.reason && result.reason.code,
      command: result.reason && result.reason.command,
      responseCode: result.reason && result.reason.responseCode,
      message: result.reason && result.reason.message
    }));

  return {
    sent: sent > 0,
    count: sent,
    failed,
    errors
  };
}

function renderItems(items) {
  if (!items.length) {
    return '<tr><td colspan="4" style="padding:12px;border-top:1px solid #eee;color:#777">Không có sản phẩm</td></tr>';
  }

  return items.map(item => {
    const quantity = Math.max(1, parseInt(item.quantity || 1, 10));
    const unitPrice = Number(item.unitPrice || item.priceNum || item.pkgPrice || 0) || 0;
    const lineTotal = Number(item.lineTotal || unitPrice * quantity) || 0;

    return `
      <tr>
        <td style="padding:12px;border-top:1px solid #eee">${escapeHtml(item.name || item.productName || 'Quà tặng')}</td>
        <td style="padding:12px;border-top:1px solid #eee;text-align:center">${quantity}</td>
        <td style="padding:12px;border-top:1px solid #eee;text-align:right">${money(unitPrice)}</td>
        <td style="padding:12px;border-top:1px solid #eee;text-align:right">${money(lineTotal)}</td>
      </tr>
    `;
  }).join('');
}

function orderHtml(payload, audience) {
  const order = payload.order || {};
  const contact = payload.contact || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const code = escapeHtml(payload.orderCode || order.orderCode || '');
  const title = audience === 'admin' ? 'EmoBox có đơn hàng mới' : 'Cảm ơn bạn đã đặt hàng tại EmoBox';

  return `
    <div style="margin:0;background:#f6f4f1;padding:24px;font-family:Arial,sans-serif;color:#24201d">
      <div style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:12px;overflow:hidden">
        <div style="padding:24px;background:#24201d;color:#fff">
          <h1 style="margin:0;font-size:22px">EmoBox</h1>
          <p style="margin:8px 0 0">${title}</p>
        </div>
        <div style="padding:24px">
          <p style="margin:0 0 16px">Mã đơn hàng: <strong>${code}</strong></p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <thead>
              <tr>
                <th style="padding:12px;text-align:left;background:#fafafa">Sản phẩm</th>
                <th style="padding:12px;text-align:center;background:#fafafa">SL</th>
                <th style="padding:12px;text-align:right;background:#fafafa">Đơn giá</th>
                <th style="padding:12px;text-align:right;background:#fafafa">Thành tiền</th>
              </tr>
            </thead>
            <tbody>${renderItems(items)}</tbody>
          </table>
          <div style="margin-top:16px;border-top:1px solid #eee;padding-top:16px">
            <p style="margin:6px 0">Tạm tính: <strong>${money(order.subtotal)}</strong></p>
            <p style="margin:6px 0">Phí giao hàng: <strong>${money(order.shippingFee)}</strong></p>
            <p style="margin:6px 0;font-size:18px">Tổng cộng: <strong>${money(order.total)}</strong></p>
            <p style="margin:6px 0">Thanh toán: <strong>${escapeHtml(methodLabel(order.paymentMethod))}</strong></p>
          </div>
          <div style="margin-top:18px;border-top:1px solid #eee;padding-top:16px">
            <p style="margin:6px 0">Người nhận: <strong>${escapeHtml(contact.name)}</strong></p>
            <p style="margin:6px 0">Điện thoại: ${escapeHtml(contact.phone)}</p>
            <p style="margin:6px 0">Email liên hệ: ${escapeHtml(contact.email)}</p>
            <p style="margin:6px 0">Địa chỉ: ${escapeHtml(contact.address)}</p>
            ${contact.message ? `<p style="margin:6px 0">Lời nhắn: ${escapeHtml(contact.message)}</p>` : ''}
          </div>
        </div>
      </div>
    </div>
  `;
}

function orderText(payload, audience) {
  const order = payload.order || {};
  const contact = payload.contact || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const title = audience === 'admin' ? 'EmoBox có đơn hàng mới' : 'Cảm ơn bạn đã đặt hàng tại EmoBox';
  const lines = [
    title,
    `Mã đơn hàng: ${payload.orderCode || order.orderCode || ''}`,
    `Tổng cộng: ${money(order.total)}`,
    `Thanh toán: ${methodLabel(order.paymentMethod)}`,
    `Người nhận: ${contact.name || ''}`,
    `Điện thoại: ${contact.phone || ''}`,
    `Email liên hệ: ${contact.email || ''}`,
    `Địa chỉ: ${contact.address || ''}`,
    '',
    'Sản phẩm:'
  ];

  for (const item of items) {
    const quantity = Math.max(1, parseInt(item.quantity || 1, 10));
    const unitPrice = Number(item.unitPrice || item.priceNum || item.pkgPrice || 0) || 0;
    lines.push(`- ${item.name || item.productName || 'Quà tặng'} x${quantity}: ${money(unitPrice * quantity)}`);
  }

  return lines.join('\n');
}

async function sendOrderEmails(payload) {
  if (!isEmailConfigured()) {
    return { sent: false, skipped: true, reason: 'Chưa cấu hình email' };
  }

  const config = getConfig();
  const contact = payload.contact || {};
  const customerTo = contact.email || (payload.user && payload.user.email);
  const messages = [];

  if (customerTo) {
    messages.push({
      from: config.from,
      to: customerTo,
      subject: `EmoBox xác nhận đơn hàng ${payload.orderCode}`,
      text: orderText(payload, 'customer'),
      html: orderHtml(payload, 'customer')
    });
  }

  const sameRecipient = customerTo && String(config.adminTo || '').toLowerCase() === String(customerTo).toLowerCase();
  if (config.adminTo && !sameRecipient) {
    messages.push({
      from: config.from,
      to: config.adminTo,
      replyTo: customerTo || undefined,
      subject: `EmoBox có đơn hàng mới ${payload.orderCode}`,
      text: orderText(payload, 'admin'),
      html: orderHtml(payload, 'admin')
    });
  }

  return sendMessages(messages);
}

function registrationText(payload) {
  const user = payload.user || {};
  const selectedPlan = user.pendingPlan && user.pendingPlan !== 'none' ? user.pendingPlan : user.plan;
  return [
    'Đăng ký tài khoản EmoBox thành công',
    `Xin chào ${user.name || user.fullName || 'bạn'},`,
    `Email: ${user.email || ''}`,
    `Gói thành viên: ${planLabel(selectedPlan || 'none')}`,
    '',
    selectedPlan && selectedPlan !== 'none'
      ? 'Tài khoản của bạn đã được ghi nhận gói thành viên đã chọn. Vui lòng hoàn tất thanh toán nếu hệ thống yêu cầu.'
      : 'Tài khoản của bạn đang ở gói thành viên thường.'
  ].join('\n');
}

function registrationHtml(payload) {
  const user = payload.user || {};
  const selectedPlan = user.pendingPlan && user.pendingPlan !== 'none' ? user.pendingPlan : user.plan;
  const content = `
    <p style="margin:0 0 16px">Xin chào <strong>${escapeHtml(user.name || user.fullName || 'bạn')}</strong>, tài khoản EmoBox của bạn đã đăng ký thành công.</p>
    <div style="border-top:1px solid #eee;border-bottom:1px solid #eee;padding:16px 0;margin:16px 0">
      <p style="margin:6px 0">Email: <strong>${escapeHtml(user.email)}</strong></p>
      <p style="margin:6px 0">Gói thành viên: <strong>${escapeHtml(planLabel(selectedPlan || 'none'))}</strong></p>
    </div>
    <p style="margin:0;color:#6b625c">${selectedPlan && selectedPlan !== 'none'
      ? 'Gói thành viên đã được ghi nhận. Vui lòng hoàn tất thanh toán nếu hệ thống yêu cầu.'
      : 'Bạn đang sử dụng gói thành viên thường của EmoBox.'}</p>
  `;
  return emailShell('Đăng ký tài khoản thành công', content);
}

async function sendRegistrationEmail(payload) {
  if (!isEmailConfigured()) {
    return { sent: false, skipped: true, reason: 'Chưa cấu hình email' };
  }

  const config = getConfig();
  const user = payload.user || {};
  const to = user.email || payload.email;

  return sendMessages([{
    from: config.from,
    to,
    subject: 'EmoBox đăng ký tài khoản thành công',
    text: registrationText(payload),
    html: registrationHtml(payload)
  }]);
}

function giftScheduleText(payload) {
  const event = payload.event || {};
  return [
    'Đăng ký đặt lịch tặng quà thành công',
    `Người nhận: ${event.recipient || ''}`,
    `Email nhận thông báo: ${event.email || ''}`,
    `Ngày tặng: ${dateLabel(event.date)}`,
    `Gói quà: ${event.pkgName || 'Quà tặng'}`,
    `Giá trị: ${money(event.priceNum || event.amount)}`,
    `Thanh toán: ${methodLabel(payload.paymentMethod)}`,
    `Trạng thái: ${event.paid ? 'Đã thanh toán' : 'Chờ thanh toán'}`,
    `Địa chỉ: ${event.address || ''}`,
    `Số điện thoại: ${event.phone || ''}`
  ].join('\n');
}

function giftScheduleHtml(payload) {
  const event = payload.event || {};
  const content = `
    <p style="margin:0 0 16px">Lịch tặng quà của bạn đã được ghi nhận thành công.</p>
    <div style="border-top:1px solid #eee;border-bottom:1px solid #eee;padding:16px 0;margin:16px 0">
      <p style="margin:6px 0">Người nhận: <strong>${escapeHtml(event.recipient)}</strong></p>
      <p style="margin:6px 0">Email nhận thông báo: <strong>${escapeHtml(event.email)}</strong></p>
      <p style="margin:6px 0">Ngày tặng: <strong>${escapeHtml(dateLabel(event.date))}</strong></p>
      <p style="margin:6px 0">Gói quà: <strong>${escapeHtml(event.pkgName || 'Quà tặng')}</strong></p>
      <p style="margin:6px 0">Giá trị: <strong>${money(event.priceNum || event.amount)}</strong></p>
      <p style="margin:6px 0">Thanh toán: <strong>${escapeHtml(methodLabel(payload.paymentMethod))}</strong></p>
      <p style="margin:6px 0">Trạng thái: <strong>${event.paid ? 'Đã thanh toán' : 'Chờ thanh toán'}</strong></p>
    </div>
    <p style="margin:6px 0">Địa chỉ giao: ${escapeHtml(event.address)}</p>
    <p style="margin:6px 0">Số điện thoại: ${escapeHtml(event.phone)}</p>
  `;
  return emailShell('Đặt lịch tặng quà thành công', content);
}

async function sendGiftScheduleEmail(payload) {
  if (!isEmailConfigured()) {
    return { sent: false, skipped: true, reason: 'Chưa cấu hình email' };
  }

  const config = getConfig();
  const user = payload.user || {};
  const event = payload.event || {};
  const to = event.email || user.email;

  return sendMessages([{
    from: config.from,
    to,
    replyTo: user.email || undefined,
    subject: `EmoBox xác nhận lịch tặng quà ${dateLabel(event.date)}`,
    text: giftScheduleText(payload),
    html: giftScheduleHtml(payload)
  }]);
}

module.exports = {
  getEmailStatus,
  isEmailConfigured,
  sendGiftScheduleEmail,
  sendOrderEmails,
  sendRegistrationEmail
};
