const nodemailer = require('nodemailer');

let transporter;

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

function getTransporter() {
  if (transporter) return transporter;

  const config = getConfig();
  if (!isEmailConfigured()) {
    throw new Error('Missing EMAIL_USER or EMAIL_APP_PASSWORD environment variable');
  }

  transporter = nodemailer.createTransport(config.host ? {
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass
    }
  } : {
    service: 'gmail',
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
    card: 'The ngan hang',
    bank: 'Chuyen khoan',
    wallet: 'Vi EmoBox',
    cod: 'Thanh toan khi nhan hang'
  };
  return labels[value] || value || 'Khong ro';
}

function planLabel(value) {
  const labels = {
    none: 'Thanh vien thuong',
    '3-months': 'Goi 3 thang',
    '6-months': 'Goi 6 thang',
    '12-months': 'Goi 12 thang'
  };
  return labels[value] || value || 'Thanh vien thuong';
}

function dateLabel(value) {
  if (!value) return 'Chua co ngay';
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
    return { sent: false, skipped: true, reason: 'Email is not configured' };
  }

  const validMessages = messages.filter(message => message && message.to);
  if (!validMessages.length) {
    return { sent: false, skipped: true, reason: 'No recipient email' };
  }

  const mailer = getTransporter();
  const results = await Promise.allSettled(validMessages.map(message => mailer.sendMail(message)));
  const sent = results.filter(result => result.status === 'fulfilled').length;
  const failed = results.length - sent;

  return {
    sent: sent > 0,
    count: sent,
    failed
  };
}

function renderItems(items) {
  if (!items.length) {
    return '<tr><td colspan="4" style="padding:12px;border-top:1px solid #eee;color:#777">Khong co san pham</td></tr>';
  }

  return items.map(item => {
    const quantity = Math.max(1, parseInt(item.quantity || 1, 10));
    const unitPrice = Number(item.unitPrice || item.priceNum || item.pkgPrice || 0) || 0;
    const lineTotal = Number(item.lineTotal || unitPrice * quantity) || 0;

    return `
      <tr>
        <td style="padding:12px;border-top:1px solid #eee">${escapeHtml(item.name || item.productName || 'Gift item')}</td>
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
  const title = audience === 'admin' ? 'EmoBox co don hang moi' : 'Cam on ban da dat hang tai EmoBox';

  return `
    <div style="margin:0;background:#f6f4f1;padding:24px;font-family:Arial,sans-serif;color:#24201d">
      <div style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:12px;overflow:hidden">
        <div style="padding:24px;background:#24201d;color:#fff">
          <h1 style="margin:0;font-size:22px">EmoBox</h1>
          <p style="margin:8px 0 0">${title}</p>
        </div>
        <div style="padding:24px">
          <p style="margin:0 0 16px">Ma don hang: <strong>${code}</strong></p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <thead>
              <tr>
                <th style="padding:12px;text-align:left;background:#fafafa">San pham</th>
                <th style="padding:12px;text-align:center;background:#fafafa">SL</th>
                <th style="padding:12px;text-align:right;background:#fafafa">Don gia</th>
                <th style="padding:12px;text-align:right;background:#fafafa">Thanh tien</th>
              </tr>
            </thead>
            <tbody>${renderItems(items)}</tbody>
          </table>
          <div style="margin-top:16px;border-top:1px solid #eee;padding-top:16px">
            <p style="margin:6px 0">Tam tinh: <strong>${money(order.subtotal)}</strong></p>
            <p style="margin:6px 0">Phi giao hang: <strong>${money(order.shippingFee)}</strong></p>
            <p style="margin:6px 0;font-size:18px">Tong cong: <strong>${money(order.total)}</strong></p>
            <p style="margin:6px 0">Thanh toan: <strong>${escapeHtml(methodLabel(order.paymentMethod))}</strong></p>
          </div>
          <div style="margin-top:18px;border-top:1px solid #eee;padding-top:16px">
            <p style="margin:6px 0">Nguoi nhan: <strong>${escapeHtml(contact.name)}</strong></p>
            <p style="margin:6px 0">Dien thoai: ${escapeHtml(contact.phone)}</p>
            <p style="margin:6px 0">Email lien he: ${escapeHtml(contact.email)}</p>
            <p style="margin:6px 0">Dia chi: ${escapeHtml(contact.address)}</p>
            ${contact.message ? `<p style="margin:6px 0">Loi nhan: ${escapeHtml(contact.message)}</p>` : ''}
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
  const title = audience === 'admin' ? 'EmoBox co don hang moi' : 'Cam on ban da dat hang tai EmoBox';
  const lines = [
    title,
    `Ma don hang: ${payload.orderCode || order.orderCode || ''}`,
    `Tong cong: ${money(order.total)}`,
    `Thanh toan: ${methodLabel(order.paymentMethod)}`,
    `Nguoi nhan: ${contact.name || ''}`,
    `Dien thoai: ${contact.phone || ''}`,
    `Email lien he: ${contact.email || ''}`,
    `Dia chi: ${contact.address || ''}`,
    '',
    'San pham:'
  ];

  for (const item of items) {
    const quantity = Math.max(1, parseInt(item.quantity || 1, 10));
    const unitPrice = Number(item.unitPrice || item.priceNum || item.pkgPrice || 0) || 0;
    lines.push(`- ${item.name || item.productName || 'Gift item'} x${quantity}: ${money(unitPrice * quantity)}`);
  }

  return lines.join('\n');
}

async function sendOrderEmails(payload) {
  if (!isEmailConfigured()) {
    return { sent: false, skipped: true, reason: 'Email is not configured' };
  }

  const config = getConfig();
  const contact = payload.contact || {};
  const customerTo = contact.email || (payload.user && payload.user.email);
  const messages = [];

  if (customerTo) {
    messages.push({
      from: config.from,
      to: customerTo,
      subject: `EmoBox xac nhan don hang ${payload.orderCode}`,
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
      subject: `EmoBox don hang moi ${payload.orderCode}`,
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
    'Dang ky tai khoan EmoBox thanh cong',
    `Xin chao ${user.name || user.fullName || 'ban'},`,
    `Email: ${user.email || ''}`,
    `Goi thanh vien: ${planLabel(selectedPlan || 'none')}`,
    '',
    selectedPlan && selectedPlan !== 'none'
      ? 'Tai khoan cua ban da duoc ghi nhan goi thanh vien da chon. Vui long hoan tat thanh toan neu he thong yeu cau.'
      : 'Tai khoan cua ban dang o goi thanh vien thuong.'
  ].join('\n');
}

function registrationHtml(payload) {
  const user = payload.user || {};
  const selectedPlan = user.pendingPlan && user.pendingPlan !== 'none' ? user.pendingPlan : user.plan;
  const content = `
    <p style="margin:0 0 16px">Xin chao <strong>${escapeHtml(user.name || user.fullName || 'ban')}</strong>, tai khoan EmoBox cua ban da dang ky thanh cong.</p>
    <div style="border-top:1px solid #eee;border-bottom:1px solid #eee;padding:16px 0;margin:16px 0">
      <p style="margin:6px 0">Email: <strong>${escapeHtml(user.email)}</strong></p>
      <p style="margin:6px 0">Goi thanh vien: <strong>${escapeHtml(planLabel(selectedPlan || 'none'))}</strong></p>
    </div>
    <p style="margin:0;color:#6b625c">${selectedPlan && selectedPlan !== 'none'
      ? 'Goi thanh vien da duoc ghi nhan. Vui long hoan tat thanh toan neu he thong yeu cau.'
      : 'Ban dang su dung goi thanh vien thuong cua EmoBox.'}</p>
  `;
  return emailShell('Dang ky tai khoan thanh cong', content);
}

async function sendRegistrationEmail(payload) {
  if (!isEmailConfigured()) {
    return { sent: false, skipped: true, reason: 'Email is not configured' };
  }

  const config = getConfig();
  const user = payload.user || {};
  const to = user.email || payload.email;

  return sendMessages([{
    from: config.from,
    to,
    subject: 'EmoBox dang ky tai khoan thanh cong',
    text: registrationText(payload),
    html: registrationHtml(payload)
  }]);
}

function giftScheduleText(payload) {
  const event = payload.event || {};
  return [
    'Dang ky dat lich tang qua thanh cong',
    `Nguoi nhan: ${event.recipient || ''}`,
    `Ngay tang: ${dateLabel(event.date)}`,
    `Goi qua: ${event.pkgName || 'Gift package'}`,
    `Gia tri: ${money(event.priceNum || event.amount)}`,
    `Thanh toan: ${methodLabel(payload.paymentMethod)}`,
    `Trang thai: ${event.paid ? 'Da thanh toan' : 'Cho thanh toan'}`,
    `Dia chi: ${event.address || ''}`,
    `So dien thoai: ${event.phone || ''}`
  ].join('\n');
}

function giftScheduleHtml(payload) {
  const event = payload.event || {};
  const content = `
    <p style="margin:0 0 16px">Lich tang qua cua ban da duoc ghi nhan thanh cong.</p>
    <div style="border-top:1px solid #eee;border-bottom:1px solid #eee;padding:16px 0;margin:16px 0">
      <p style="margin:6px 0">Nguoi nhan: <strong>${escapeHtml(event.recipient)}</strong></p>
      <p style="margin:6px 0">Ngay tang: <strong>${escapeHtml(dateLabel(event.date))}</strong></p>
      <p style="margin:6px 0">Goi qua: <strong>${escapeHtml(event.pkgName || 'Gift package')}</strong></p>
      <p style="margin:6px 0">Gia tri: <strong>${money(event.priceNum || event.amount)}</strong></p>
      <p style="margin:6px 0">Thanh toan: <strong>${escapeHtml(methodLabel(payload.paymentMethod))}</strong></p>
      <p style="margin:6px 0">Trang thai: <strong>${event.paid ? 'Da thanh toan' : 'Cho thanh toan'}</strong></p>
    </div>
    <p style="margin:6px 0">Dia chi giao: ${escapeHtml(event.address)}</p>
    <p style="margin:6px 0">So dien thoai: ${escapeHtml(event.phone)}</p>
  `;
  return emailShell('Dat lich tang qua thanh cong', content);
}

async function sendGiftScheduleEmail(payload) {
  if (!isEmailConfigured()) {
    return { sent: false, skipped: true, reason: 'Email is not configured' };
  }

  const config = getConfig();
  const user = payload.user || {};
  const event = payload.event || {};

  return sendMessages([{
    from: config.from,
    to: user.email,
    subject: `EmoBox xac nhan lich tang qua ${dateLabel(event.date)}`,
    text: giftScheduleText(payload),
    html: giftScheduleHtml(payload)
  }]);
}

module.exports = {
  isEmailConfigured,
  sendGiftScheduleEmail,
  sendOrderEmails,
  sendRegistrationEmail
};
