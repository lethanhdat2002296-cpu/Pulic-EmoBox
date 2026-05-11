// js/app.js

// Xóa dữ liệu 1 lần theo yêu cầu
if (!localStorage.getItem('data_cleared_v1')) {
  localStorage.clear();
  localStorage.setItem('data_cleared_v1', 'true');
  console.log("Đã xóa toàn bộ dữ liệu User, Giỏ hàng, Lịch sử!");
}
// Khởi tạo giỏ hàng từ localStorage
let cart = JSON.parse(localStorage.getItem('emobox_cart')) || [];

function updateCartBadge() {
  const badge = document.getElementById('cartBadge');
  if (badge) {
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    badge.textContent = totalItems;
    badge.style.display = totalItems > 0 ? 'flex' : 'none';
  }
}

function addToCart(boxId) {
  const existingItem = cart.find(item => item.id === boxId);
  if (existingItem) {
    existingItem.quantity += 1;
  } else {
    cart.push({ id: boxId, quantity: 1 });
  }
  localStorage.setItem('emobox_cart', JSON.stringify(cart));
  updateCartBadge();
  showToast('Đã thêm vào giỏ hàng!');
}

function showToast(msg, duration) {
  const toast = document.getElementById('toast');
  if (toast) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, duration || 3000);
  }
}

function toggleNav() {
  const navLinks = document.getElementById('navLinks');
  navLinks.classList.toggle('active');
}

function toggleUserMenu() {
  const menu = document.getElementById('userMenu');
  menu.classList.toggle('active');
}

function normalizeFooterLinks() {
  const replacements = [
    { text: 'Câu Hỏi Thường Gặp', href: 'faq.html' },
    { text: 'Câu Hỏi Thường Gặp', href: 'faq.html' },
    { text: 'Vận chuyển & Đổi trả', href: 'shipping-returns.html' },
    { text: 'Theo dõi Đơn hàng', href: 'track-order.html' },
    { text: 'Chính sách Bảo mật', href: 'privacy.html' },
    { text: 'Điều khoản Dịch vụ', href: 'terms.html' }
  ];

  document.querySelectorAll('footer a').forEach(link => {
    const label = link.textContent.trim();
    const match = replacements.find(item => item.text === label);
    if (match) link.href = match.href;
    if (label === 'in') {
      link.href = 'https://www.linkedin.com/company/emobox/';
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = 'LinkedIn EmoBox';
    }
    if (label === 'ig') {
      link.href = 'https://www.instagram.com/emobox.vn/';
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = 'Instagram EmoBox';
    }
  });
}

function ensureUserMenuLink(userMenuBody, href, text) {
  if (!userMenuBody || userMenuBody.querySelector(`a[href="${href}"]`)) return;
  const link = document.createElement('a');
  link.href = href;
  link.className = 'user-menu-item';
  link.textContent = text;
  userMenuBody.appendChild(link);
}

function ensureCustomGiftNavLink() {
  const navLinks = document.getElementById('navLinks');
  if (!navLinks) return;

  navLinks.querySelectorAll('a').forEach(link => {
    const label = link.textContent.trim();
    if (label === 'Subscription') link.textContent = 'Gói thành viên';
    if (label === 'Trang Chủ') link.textContent = 'Trang chủ';
    if (label === 'Đặt Lịch') link.textContent = 'Đặt lịch';
    if (label === 'Liên Hệ') link.textContent = 'Liên hệ';
  });

  if (navLinks.querySelector('a[href="custom-gift.html"]')) return;
  const link = document.createElement('a');
  link.href = 'custom-gift.html';
  link.className = 'nav-link';
  link.textContent = 'Thiết kế quà';

  const plansLink = navLinks.querySelector('a[href="plans.html"]');
  if (plansLink) navLinks.insertBefore(link, plansLink);
  else navLinks.appendChild(link);
}

function normalizeVietnameseLabels() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || ['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT'].includes(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(node => {
    node.nodeValue = node.nodeValue
      .replace(/Subscription/g, 'Gói thành viên')
      .replace(/Shop Now/g, 'Mua ngay')
      .replace(/Add to Cart/g, 'Thêm vào giỏ')
      .replace(/Checkout/g, 'Thanh toán');
  });
}

// Xử lý click ra ngoài để đóng user menu
document.addEventListener('click', (e) => {
  const userBtn = document.getElementById('userBtn');
  const userMenu = document.getElementById('userMenu');
  if (userBtn && userMenu && !userBtn.contains(e.target) && !userMenu.contains(e.target)) {
    userMenu.classList.remove('active');
  }
});

// Mobile dropdown toggle
document.querySelectorAll('.nav-dropdown > a').forEach(el => {
  el.addEventListener('click', (e) => {
    if (window.innerWidth <= 768) {
      e.preventDefault();
      e.target.parentElement.classList.toggle('active');
    }
  });
});

// Render dữ liệu trang chủ
function renderEmotionGrid() {
  const grid = document.getElementById('emotionGrid');
  if (!grid || typeof EMOTIONS === 'undefined') return;
  
  grid.innerHTML = EMOTIONS.map(emo => `
    <a href="finder.html?emotion=${emo.id}" class="emotion-card">
      <div class="emotion-icon">${emo.emoji}</div>
      <div class="emotion-name">${emo.label}</div>
    </a>
  `).join('');
}

function renderFeaturedBoxes() {
  const grid = document.getElementById('featuredGrid');
  if (!grid || typeof FEATURED_BOXES === 'undefined') return;
  
  grid.innerHTML = FEATURED_BOXES.map(box => `
    <div class="gift-card">
      <div onclick="openFeaturedModal('${box.id}')" class="gift-img-wrap" style="cursor: pointer;">
        ${box.badge ? `<span class="gift-badge">${box.badge}</span>` : ''}
        <img src="${box.image}" alt="${box.name}" class="gift-img">
      </div>
      <div class="gift-content">
        <h3 class="gift-title" onclick="openFeaturedModal('${box.id}')" style="cursor: pointer; display: inline-block;">${box.name}</h3>
        <p class="gift-desc">${box.desc}</p>
        <div class="gift-footer">
          <span class="gift-price">${formatPrice(box.price)}</span>
          <button class="btn btn-primary" onclick="openFeaturedModal('${box.id}')">Thêm giỏ</button>
        </div>
      </div>
    </div>
  `).join('');
}

function handleLogout(e) {
  if (e) e.preventDefault();
  localStorage.removeItem('emobox_user');
  window.location.href = 'login.html';
}

// Khởi chạy khi load
document.addEventListener('DOMContentLoaded', () => {
  updateCartBadge();
  normalizeFooterLinks();
  ensureCustomGiftNavLink();
  normalizeVietnameseLabels();

    // Update User Menu in Navbar across all pages
  const userMenuBody = document.querySelector('.user-menu-body');
  const currentUser = JSON.parse(localStorage.getItem('emobox_user'));
  
  if (userMenuBody) {

    // Remove existing login/logout links if any
    const existingAuthLinks = userMenuBody.querySelectorAll('a[href="login.html"], a[onclick="handleLogout(event)"], a[onclick="handleLogout()"]');
    existingAuthLinks.forEach(link => link.remove());

    const authLink = document.createElement('a');
    authLink.className = 'user-menu-item';
    
    if (currentUser) {
      authLink.textContent = 'Đăng xuất';
      authLink.href = '#';
      authLink.onclick = handleLogout;
    } else {
      authLink.textContent = 'Đăng nhập / Đăng ký';
      authLink.href = 'login.html';
    }
    
    userMenuBody.insertBefore(authLink, userMenuBody.firstChild);
    ensureUserMenuLink(userMenuBody, 'custom-gift.html', 'Thiết kế quà tặng');
    ensureUserMenuLink(userMenuBody, 'order-history.html', '📜 Lịch sử đơn hàng');
    ensureUserMenuLink(userMenuBody, 'track-order.html', '🔎 Theo dõi đơn hàng');
    userMenuBody.querySelectorAll('a[href="plans.html"]').forEach(link => {
      link.textContent = 'Gói thành viên';
    });
  }

  if (currentUser) {
    const navUserName = document.querySelector('.user-name');
    const navAvatar = document.querySelector('.user-avatar-sm');
    const navUserSub = document.querySelector('.user-sub');
    
    if (navUserName) navUserName.textContent = currentUser.name;
    if (navAvatar) navAvatar.textContent = currentUser.name.charAt(0).toUpperCase();
    
    if (navUserSub) {
      let planLabel = 'Tài khoản thường';
      if(currentUser.plan === '3-months') planLabel = 'Thành viên 3 Tháng';
      if(currentUser.plan === '6-months') planLabel = 'Thành viên 6 Tháng';
      if(currentUser.plan === '12-months') planLabel = 'Thành viên 12 Tháng';
      navUserSub.textContent = planLabel;
    }
  }

  // Intercept calendar and wallet links
  const protectedLinks = document.querySelectorAll('a[href="calendar.html"], a[href="wallet.html"], a[href="custom-gift.html"]');
  protectedLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      const user = JSON.parse(localStorage.getItem('emobox_user'));
      if (!user || user.plan === 'none' || !user.plan) {
        e.preventDefault(); // prevent navigation
        if (typeof showToast === 'function') {
          showToast('Chức năng dành cho thành viên');
        } else {
          alert('Chức năng dành cho thành viên');
        }
      }
    });
  });

  // Hard check for wallet page if accessed directly
  if (window.location.pathname.includes('wallet.html')) {
    if (!currentUser || currentUser.plan === 'none' || !currentUser.plan) {
      alert('Chức năng dành cho thành viên. Đang chuyển hướng...');
      window.location.href = 'index.html';
    }
  }

  // Update plan buttons in plans.html
  if (window.location.pathname.includes('plans.html') && currentUser) {
    const planButtons = document.querySelectorAll('.plan-card button');
    
    const planLevels = { 'none': 0, '3-months': 1, '6-months': 2, '12-months': 3 };
    const currentLevel = planLevels[currentUser.plan] || 0;
    
    planButtons.forEach(btn => {
      let btnPlan = 'none';
      if (btn.textContent.includes('3 Tháng') || btn.getAttribute('onclick')?.includes('3-months')) btnPlan = '3-months';
      else if (btn.textContent.includes('6 Tháng') || btn.getAttribute('onclick')?.includes('6-months')) btnPlan = '6-months';
      else if (btn.textContent.includes('12 Tháng') || btn.getAttribute('onclick')?.includes('12-months')) btnPlan = '12-months';
      
      const btnLevel = planLevels[btnPlan];
      
      if (btnLevel === currentLevel && currentLevel > 0) {
        btn.textContent = 'Đang sử dụng';
        btn.style.opacity = '0.7';
        btn.disabled = true;
      } else if (btnLevel < currentLevel && btnLevel > 0) {
        btn.textContent = 'Chỉ được nâng cấp';
        btn.style.opacity = '0.5';
        btn.disabled = true;
      }
    });
  }

  // Khởi chạy kiểm tra hết hạn gói
  checkPlanExpiration();

  // Thêm nút DEV để test chức năng hết hạn
  if (currentUser && currentUser.plan !== 'none') {
    const devBtnHtml = `<button onclick="devForceExpire()" style="position: fixed; bottom: 20px; left: 20px; z-index: 9999; background: #ef4444; color: white; border: none; padding: 0.5rem 1rem; border-radius: 8px; font-weight: bold; cursor: pointer; opacity: 0.8; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">[Dev] Giả lập Hết hạn</button>`;
    document.body.insertAdjacentHTML('beforeend', devBtnHtml);
  }
});

// --- LOGIC HẾT HẠN & GIA HẠN GÓI ---
function checkPlanExpiration() {
  const user = JSON.parse(localStorage.getItem('emobox_user'));
  if (!user || user.plan === 'none' || !user.registeredAt) return;

  // Giả lập dev force expire
  const isForceExpired = localStorage.getItem('dev_force_expire') === 'true';

  const planDurations = { '3-months': 90, '6-months': 180, '12-months': 365 };
  const planPrices = { '3-months': 299000, '6-months': 499000, '12-months': 799000 };
  
  const daysToAdd = planDurations[user.plan] || 0;
  const regDate = new Date(user.registeredAt);
  const expirationDate = new Date(regDate.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
  
  if (new Date() > expirationDate || isForceExpired) {
    if (isForceExpired) localStorage.removeItem('dev_force_expire'); // Reset flag
    
    const price = planPrices[user.plan] || 0;
    if (user.balance >= price) {
      // Tự động gia hạn (Trừ phí gia hạn, sau đó cấp lại điểm tương ứng -> Net = 0)
      // Để hiển thị rõ ràng, ta log việc trừ và cộng, nhưng kết quả balance không đổi.
      user.registeredAt = new Date().toISOString();
      localStorage.setItem('emobox_user', JSON.stringify(user));
      if (window.EmoBoxApi) {
        EmoBoxApi.activateSubscription(user, user.plan, { name: 'Auto renewal ' + user.plan, price }, 'wallet');
      }
      showToast('Gói thành viên của bạn đã hết hạn và được TỰ ĐỘNG GIA HẠN. Phí gia hạn đã được trừ vào ví EmoBox.');
    } else {
      showExpirationModal(user.plan, price, user.balance);
    }
  }
}

function showExpirationModal(plan, price, balance) {
  const modalHtml = `
    <div id="expirationModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 9999; display: flex; align-items: center; justify-content: center;">
      <div style="background: white; padding: 2rem; border-radius: 24px; max-width: 450px; width: 90%; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.2);">
        <h2 style="font-weight: 800; color: #0f172a; margin-bottom: 1rem;">Gói thành viên đã hết hạn!</h2>
        <p style="color: var(--text-muted); margin-bottom: 1.5rem;">Số dư ví EmoBox hiện tại của bạn (<strong style="color: #0f172a;">${formatPrice(balance)}</strong>) không đủ để tự động gia hạn gói (<strong style="color: #ef4444;">${formatPrice(price)}</strong>).</p>
        <p style="color: var(--text-muted); margin-bottom: 2rem; font-size: 0.9rem;">Bạn có muốn thanh toán qua Ngân hàng để tiếp tục sử dụng các đặc quyền không?</p>
        <div style="display: flex; flex-direction: column; gap: 0.75rem;">
          <button onclick="gotoRenewPayment('${plan}')" class="btn btn-primary" style="width: 100%; height: 48px;">Thanh toán Ngân hàng</button>
          <button onclick="showWithdrawModal()" class="btn" style="width: 100%; height: 48px; background: transparent; border: 1px solid var(--border); color: var(--text-muted);">Không gia hạn & Rút tiền dư</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function gotoRenewPayment(plan) {
  const user = JSON.parse(localStorage.getItem('emobox_user'));
  user.pendingPlan = plan;
  localStorage.setItem('emobox_user', JSON.stringify(user));
  window.location.href = 'plan-payment.html';
}

function showWithdrawModal() {
  const oldModal = document.getElementById('expirationModal');
  if (oldModal) oldModal.remove();

  const user = JSON.parse(localStorage.getItem('emobox_user'));
  const balance = user.balance || 0;

  const modalHtml = `
    <div id="withdrawModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 9999; display: flex; align-items: center; justify-content: center;">
      <div style="background: white; padding: 2rem; border-radius: 24px; max-width: 450px; width: 90%; box-shadow: 0 20px 40px rgba(0,0,0,0.2);">
        <h2 style="font-weight: 800; color: #0f172a; margin-bottom: 0.5rem; text-align: center;">Rút Tiền Ví EmoBox</h2>
        <p style="color: var(--text-muted); margin-bottom: 1.5rem; text-align: center; font-size: 0.9rem;">Số tiền hoàn trả: <strong style="color: #0ea5e9; font-size: 1.1rem;">${formatPrice(balance)}</strong></p>
        
        <div style="margin-bottom: 1rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.5rem;">Ngân hàng</label>
          <input type="text" id="wdBank" placeholder="VD: Vietcombank" style="width: 100%; padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px;" required minlength="2">
        </div>
        <div style="margin-bottom: 1rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.5rem;">Số tài khoản</label>
          <input type="text" id="wdAcc" placeholder="Nhập số tài khoản" style="width: 100%; padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px;" required pattern="^[0-9]+$" title="Số tài khoản chỉ chứa chữ số">
        </div>
        <div style="margin-bottom: 1.5rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.5rem;">Chủ tài khoản</label>
          <input type="text" id="wdName" placeholder="Tên in hoa không dấu" style="width: 100%; padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px;" required pattern="^[a-zA-Z\\s]+$" title="Tên in trên thẻ không dấu">
        </div>

        <button onclick="confirmWithdraw()" class="btn btn-primary" style="width: 100%; height: 48px;">Xác nhận rút tiền</button>
        <button onclick="cancelWithdraw()" class="btn" style="width: 100%; height: 40px; background: transparent; border: none; color: var(--text-muted); margin-top: 0.5rem;">Đóng</button>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

async function confirmWithdraw() {
  const bank = document.getElementById('wdBank');
  const acc = document.getElementById('wdAcc');
  const name = document.getElementById('wdName');
  
  if (!bank.value || !acc.value || !name.value || !bank.checkValidity() || !acc.checkValidity() || !name.checkValidity()) {
    alert("Vui lòng điền đầy đủ và đúng định dạng thông tin ngân hàng!");
    return;
  }
  
  const bankVal = bank.value;
  const accVal = acc.value;
  const nameVal = name.value;

  const user = JSON.parse(localStorage.getItem('emobox_user'));
  const withdrawAmount = user.balance || 0;
  user.balance = 0;
  user.plan = 'none';
  user.registeredAt = null;
  localStorage.setItem('emobox_user', JSON.stringify(user));
  if (window.EmoBoxApi) {
    await EmoBoxApi.recordWalletWithdrawal(user, withdrawAmount, {
      bank: bankVal,
      accountNumber: accVal,
      accountName: nameVal
    });
  }

  document.getElementById('withdrawModal').remove();
  showToast('🎉 Đã gửi lệnh rút tiền thành công! Gói của bạn đã bị hủy.');
  
  setTimeout(() => {
    window.location.href = 'index.html';
  }, 2000);
}

function cancelWithdraw() {
  document.getElementById('withdrawModal').remove();
  // Nếu hủy rút tiền, có thể quay lại index.html hoặc giữ nguyên trạng thái expired
  window.location.href = 'index.html';
}

function devForceExpire() {
  localStorage.setItem('dev_force_expire', 'true');
  window.location.reload();
}
