
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
    `Email nhan thong bao: ${event.email || ''}`,
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
      <p style="margin:6px 0">Email nhan thong bao: <strong>${escapeHtml(event.email)}</strong></p>
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
  const to = event.email || user.email;

  return sendMessages([{
    from: config.from,
    to,
    replyTo: user.email || undefined,
    subject: `EmoBox xac nhan lich tang qua ${dateLabel(event.date)}`,
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
