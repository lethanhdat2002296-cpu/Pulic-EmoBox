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

  if (!messages.length) {
    return { sent: false, skipped: true, reason: 'No recipient email' };
  }

  const mailer = getTransporter();
  const results = await Promise.allSettled(messages.map(message => mailer.sendMail(message)));
  const sent = results.filter(result => result.status === 'fulfilled').length;
  const failed = results.length - sent;

  return {
    sent: sent > 0,
    count: sent,
    failed
  };
}

module.exports = {
  isEmailConfigured,
  sendOrderEmails
};
