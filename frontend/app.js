/* ═══════════════════════════════════════════════════════════════
   LendBTC — Frontend Application Logic
   Pure vanilla JS — no framework, no build step
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
const STATE = {
  wallet: {
    connected: false,
    address: null,
    shortAddress: null,
    btcBalance: 1.28340000,
    motoBalance: 25000,
    pillBalance: 1500,
  },
  user: {
    btcDeposited:  0.5,
    btcEarned:     0.00210000,
    motoDeposited: 12500,
    motoEarned:    142.5,
    pillDeposited: 0,
    pillEarned:    0,
    motoBorrowed:  8500,
    btcBorrowed:   0,
    pillBorrowed:  0,
    pillStaked:    500,
    healthFactor:  1.847,
    netWorth:      59250,
    loopActive:    false,
    loopLevel:     0,
  },
  protocol: {
    tvl:              4234567,
    totalBorrowed:    1224715,
    btcPrice:         97450,
    motoPrice:        0.842,
    pillPrice:        0.124,
    btcTotalDeposits: 25.5,
    btcTotalBorrowed: 12.3,
    btcSupplyAPR:     4.2,
    btcBorrowAPR:     8.7,
    btcUtilization:   48.24,
    motoTotalDeposits: 1250000,
    motoTotalBorrowed: 430000,
    motoSupplyAPR:    6.8,
    motoBorrowAPR:    14.2,
    motoUtilization:  34.4,
    pillTotalDeposits: 890000,
    pillTotalBorrowed: 210000,
    pillSupplyAPR:    5.1,
    pillBorrowAPR:    11.4,
    pillUtilization:  23.60,
  },
  ui: {
    currentPage:    'dashboard',
    currentEarnTab: 'btc',
    currentBorrowPool: 'moto',
    currentRepayPool:  'moto',
    isLoading:      false,
    dropdownOpen:   false,
  },
  txHistory: [
    { type: 'Deposit',  asset: 'BTC',  amount: '+0.50 BTC',    usd: '+$48,725.00', timeAgo: '2 days ago',    status: 'Confirmed', hash: '3f4a9c2e' },
    { type: 'Deposit',  asset: 'MOTO', amount: '+12,500 MOTO', usd: '+$10,525.00', timeAgo: '2 days ago',    status: 'Confirmed', hash: 'a1b2c3d4' },
    { type: 'Borrow',   asset: 'MOTO', amount: '-8,500 MOTO',  usd: '-$7,157.00',  timeAgo: '1 day ago',     status: 'Confirmed', hash: 'd5e6f7a8' },
    { type: 'Deposit',  asset: 'PILL', amount: '+500 PILL',    usd: '+$62.00',     timeAgo: '18 hours ago',  status: 'Confirmed', hash: '9b0c1d2e' },
    { type: 'Repay',    asset: 'MOTO', amount: '+500 MOTO',    usd: '+$421.00',    timeAgo: '6 hours ago',   status: 'Confirmed', hash: '3e4f5a6b' },
  ],
};

// Mock wallet addresses
const MOCK_ADDRESSES = [
  'bc1q4xfcvl5j7kqrm9xdlw2eph4rjnhef5gxtzpsm',
  'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
  'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
];

// ─────────────────────────────────────────────
// FORMATTING UTILS
// ─────────────────────────────────────────────
function fmtUSD(n, short = false) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (short) {
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  }
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtBTC(n, dp = 8) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toFixed(dp) + ' BTC';
}

function fmtToken(n, symbol, short = false) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (short) {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M ' + symbol;
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K ' + symbol;
  }
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + symbol;
}

function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toFixed(1) + '%';
}

function fmtHF(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (n >= 999) return '∞';
  return n.toFixed(3);
}

function hfColor(hf) {
  if (hf >= 1.5)  return 'var(--green)';
  if (hf >= 1.2)  return 'var(--yellow)';
  return 'var(--red)';
}

function hfBadgeClass(hf) {
  if (hf >= 1.5)  return 'badge-safe';
  if (hf >= 1.2)  return 'badge-warning';
  return 'badge-danger';
}

function hfRiskLabel(hf) {
  if (hf >= 1.5)  return 'Safe';
  if (hf >= 1.35) return 'Moderate';
  if (hf >= 1.2)  return 'Elevated Risk';
  return 'High Risk';
}

function shortenAddress(addr) {
  if (!addr) return '';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function randomHash() {
  return Math.random().toString(16).slice(2, 10);
}

// ─────────────────────────────────────────────
// NUMBER COUNT-UP ANIMATION
// ─────────────────────────────────────────────
function animateCount(el, endVal, prefix = '', suffix = '', duration = 700, decimals = 0) {
  const startTime = performance.now();
  const startVal = 0;

  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // Ease out
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = startVal + (endVal - startVal) * eased;
    const formatted = current.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    el.textContent = prefix + formatted + suffix;
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ─────────────────────────────────────────────
// DOM HELPERS
// ─────────────────────────────────────────────
function el(id) { return document.getElementById(id); }
function setText(id, val) { const e = el(id); if (e) e.textContent = val; }
function setHtml(id, val) { const e = el(id); if (e) e.innerHTML = val; }
function show(id) { const e = el(id); if (e) e.classList.remove('hidden'); }
function hide(id) { const e = el(id); if (e) e.classList.add('hidden'); }
function toggle(id) { const e = el(id); if (e) e.classList.toggle('hidden'); }

// ─────────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────────
const WALLET_GATED_PAGES = new Set(['portfolio']);

function navigateTo(page) {
  // Hide all pages
  document.querySelectorAll('.page').forEach(p => {
    p.classList.remove('active');
    p.classList.add('hidden');
  });

  // Update nav links
  document.querySelectorAll('.nav-link').forEach(l => {
    l.classList.toggle('active', l.dataset.page === page);
  });
  document.querySelectorAll('.mobile-link').forEach(l => {
    l.classList.toggle('active', l.dataset.page === page);
  });

  // Close dropdown if open
  closeWalletDropdown();

  // Wallet-gated
  if (WALLET_GATED_PAGES.has(page) && !STATE.wallet.connected) {
    const pageEl = el('page-' + page);
    if (pageEl) { pageEl.classList.add('active'); pageEl.classList.remove('hidden'); }
    show('empty-state-overlay');
    STATE.ui.currentPage = page;
    return;
  }
  hide('empty-state-overlay');

  const pageEl = el('page-' + page);
  if (pageEl) {
    pageEl.classList.add('active');
    pageEl.classList.remove('hidden');
    // Trigger fade-in for children
    pageEl.querySelectorAll('.fade-in').forEach((el, i) => {
      el.style.animationDelay = (i * 0.05) + 's';
    });
  }

  STATE.ui.currentPage = page;

  if (page === 'dashboard') renderDashboard();
  if (page === 'portfolio') renderPortfolio();
}

function closeMobileMenu() {
  hide('mobile-menu');
  el('hamburger').classList.remove('open');
}

function toggleMobileMenu() {
  const menu = el('mobile-menu');
  menu.classList.toggle('hidden');
}

// ─────────────────────────────────────────────
// WALLET MODAL
// ─────────────────────────────────────────────
function openWalletModal() {
  show('wallet-modal');
  closeWalletDropdown();
}

function closeWalletModal(evt) {
  if (!evt || evt.target === el('wallet-modal')) {
    hide('wallet-modal');
  }
}

function connectWallet(type) {
  hide('wallet-modal');

  // Simulate connection delay
  const addr = MOCK_ADDRESSES[0];
  setTimeout(() => {
    STATE.wallet.connected = true;
    STATE.wallet.address = addr;
    STATE.wallet.shortAddress = shortenAddress(addr);

    // Update UI
    hide('btn-connect');
    hide('btn-connect-mobile');
    show('wallet-connected');
    show('wallet-connected-mobile');

    const shortEl = el('wallet-address-short');
    const shortMob = el('wallet-address-short-mobile');
    if (shortEl)  shortEl.textContent  = STATE.wallet.shortAddress;
    if (shortMob) shortMob.textContent = STATE.wallet.shortAddress;

    const balEl = el('wallet-btc-bal');
    if (balEl) balEl.textContent = STATE.wallet.btcBalance.toFixed(4) + ' BTC';

    // Wallet dropdown data
    const fullAddr = el('wd-full-address');
    if (fullAddr) fullAddr.textContent = STATE.wallet.address;
    const wdBal = el('wd-btc-balance');
    if (wdBal) wdBal.textContent = fmtBTC(STATE.wallet.btcBalance, 4);

    // Refresh current page
    renderCurrentPage();

    showToast('Wallet Connected', 'OPWallet connected successfully.', 'success');
  }, 800);

  // Show connecting spinner state briefly
  showToast('Connecting...', 'Connecting to ' + (type === 'opwallet' ? 'OPWallet' : type) + '...', 'pending');
}

function disconnectWallet() {
  STATE.wallet.connected = false;
  STATE.wallet.address = null;
  STATE.wallet.shortAddress = null;

  show('btn-connect');
  show('btn-connect-mobile');
  hide('wallet-connected');
  hide('wallet-connected-mobile');
  closeWalletDropdown();

  renderCurrentPage();
  showToast('Disconnected', 'Wallet disconnected.', 'pending');
}

function toggleWalletDropdown() {
  const dd = el('wallet-dropdown');
  if (dd.classList.contains('hidden')) {
    show('wallet-dropdown');
    STATE.ui.dropdownOpen = true;
    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', outsideDropdownHandler);
    }, 50);
  } else {
    closeWalletDropdown();
  }
}

function closeWalletDropdown() {
  hide('wallet-dropdown');
  STATE.ui.dropdownOpen = false;
  document.removeEventListener('click', outsideDropdownHandler);
}

function outsideDropdownHandler(e) {
  const dd = el('wallet-dropdown');
  const chip = el('wallet-address-chip');
  if (dd && chip && !dd.contains(e.target) && !chip.contains(e.target)) {
    closeWalletDropdown();
  }
}

function copyAddress() {
  const addr = STATE.wallet.address;
  if (addr && navigator.clipboard) {
    navigator.clipboard.writeText(addr).then(() => showToast('Copied!', 'Address copied to clipboard.', 'success'));
  }
}

function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'Address copied to clipboard.', 'success'));
  }
}

// ─────────────────────────────────────────────
// TOAST NOTIFICATIONS
// ─────────────────────────────────────────────
function showToast(title, message, type = 'pending') {
  const container = el('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = {
    pending: '⟳',
    success: '✓',
    error:   '✕',
  };

  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || '•'}</div>
    <div>
      <div style="font-weight:700;font-size:13px">${title}</div>
      ${message ? `<div style="font-size:12px;opacity:0.75;margin-top:2px">${message}</div>` : ''}
    </div>
  `;

  container.appendChild(toast);

  const lifetime = type === 'pending' ? 3000 : 4000;
  setTimeout(() => {
    toast.classList.add('exiting');
    setTimeout(() => toast.remove(), 300);
  }, lifetime);
}

// ─────────────────────────────────────────────
// TRANSACTION SIMULATION
// ─────────────────────────────────────────────
function showTxModal(state, data = {}) {
  const inner = el('tx-modal-inner');
  if (!inner) return;

  if (state === 'pending') {
    inner.innerHTML = `
      <div class="tx-spinner-wrap"><div class="tx-spinner"></div></div>
      <div class="tx-modal-title">Transaction Submitted</div>
      <div class="tx-modal-desc">Your transaction has been broadcast to the Bitcoin network. Waiting for OP_NET relay confirmation...</div>
      <div class="tx-hash">Tx: 0x${randomHash()}...${randomHash()}</div>
    `;
  } else if (state === 'success') {
    inner.innerHTML = `
      <div class="tx-success-icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round">
          <polyline points="20 6 9 17 4 12" class="tx-success-check"/>
        </svg>
      </div>
      <div class="tx-modal-title">Transaction Confirmed</div>
      <div class="tx-modal-desc">${data.message || 'Your transaction has been confirmed on-chain.'}</div>
      <div class="tx-hash">Tx: 0x${randomHash()}...${randomHash()}</div>
      <button class="btn-primary btn-full" onclick="closeTxModal()">Done</button>
    `;
  }
  show('tx-modal');
}

function closeTxModal() { hide('tx-modal'); }

function setButtonLoading(btnId, loading) {
  const btn = el(btnId);
  if (!btn) return;
  const textEl = btn.querySelector('.btn-text');
  const spinEl = btn.querySelector('.btn-spinner');
  btn.disabled = loading;
  if (textEl) textEl.style.opacity = loading ? '0.5' : '1';
  if (spinEl) spinEl.classList.toggle('hidden', !loading);
}

function submitTransaction(type, asset) {
  if (!STATE.wallet.connected) { openWalletModal(); return; }

  const btnMap = {
    'deposit_btc':    'btc-deposit-btn',
    'deposit_moto':   'moto-deposit-btn',
    'deposit_pill':   'pill-deposit-btn',
    'withdraw_btc':   'btc-withdraw-btn',
    'withdraw_moto':  'moto-withdraw-btn',
    'withdraw_pill':  'pill-withdraw-btn',
    'borrow':         'borrow-submit-btn',
    'repay':          'repay-submit-btn',
    'stake_pill':     null,
    'unstake_pill':   null,
  };

  const btnKey = asset ? `${type}_${asset}` : type;
  const btnId  = btnMap[btnKey] || null;

  // Validate amount
  let amount = 0;
  if (type === 'deposit' && asset) {
    const input = el(`${asset}-deposit-input`);
    amount = parseFloat(input?.value) || 0;
    if (amount <= 0) { showToast('Invalid Amount', 'Please enter a valid amount.', 'error'); return; }
  }
  if (type === 'withdraw' && asset) {
    const input = el(`${asset}-withdraw-input`);
    amount = parseFloat(input?.value) || 0;
    if (amount <= 0) { showToast('Invalid Amount', 'Please enter a valid amount.', 'error'); return; }
  }
  if (type === 'borrow') {
    const input = el('borrow-amount-input');
    amount = parseFloat(input?.value) || 0;
    if (amount <= 0) { showToast('Invalid Amount', 'Please enter a valid amount.', 'error'); return; }
  }
  if (type === 'repay') {
    const input = el('repay-amount-input');
    amount = parseFloat(input?.value) || 0;
    if (amount <= 0) { showToast('Invalid Amount', 'Please enter a valid amount.', 'error'); return; }
  }

  if (btnId) setButtonLoading(btnId, true);

  showToast('Transaction Submitted', 'Awaiting OP_NET relay...', 'pending');
  showTxModal('pending');

  setTimeout(() => {
    // Apply state changes
    applyTransaction(type, asset, amount);

    if (btnId) setButtonLoading(btnId, false);

    // Clear inputs
    clearInputs(type, asset);

    showTxModal('success', { message: getTxSuccessMsg(type, asset, amount) });
    showToast('Transaction Confirmed', getTxSuccessMsg(type, asset, amount), 'success');

    // Update UI
    renderCurrentPage();
  }, 2000);
}

function applyTransaction(type, asset, amount) {
  if (type === 'deposit') {
    if (asset === 'btc') {
      STATE.user.btcDeposited += amount;
      STATE.wallet.btcBalance -= amount;
      STATE.protocol.btcTotalDeposits += amount;
    } else if (asset === 'moto') {
      STATE.user.motoDeposited += amount;
      STATE.wallet.motoBalance -= amount;
      STATE.protocol.motoTotalDeposits += amount;
    } else if (asset === 'pill') {
      STATE.user.pillDeposited += amount;
      STATE.wallet.pillBalance -= amount;
      STATE.protocol.pillTotalDeposits += amount;
    }
  }
  if (type === 'withdraw') {
    if (asset === 'btc') {
      STATE.user.btcDeposited = Math.max(0, STATE.user.btcDeposited - amount);
      STATE.wallet.btcBalance += amount;
    } else if (asset === 'moto') {
      STATE.user.motoDeposited = Math.max(0, STATE.user.motoDeposited - amount);
      STATE.wallet.motoBalance += amount;
    } else if (asset === 'pill') {
      STATE.user.pillDeposited = Math.max(0, STATE.user.pillDeposited - amount);
      STATE.wallet.pillBalance += amount;
    }
  }
  if (type === 'borrow') {
    const pool = STATE.ui.currentBorrowPool;
    if (pool === 'moto') {
      STATE.user.motoBorrowed += amount;
      STATE.wallet.motoBalance += amount;
    } else if (pool === 'btc') {
      STATE.user.btcBorrowed += amount;
      STATE.wallet.btcBalance += amount;
    } else if (pool === 'pill') {
      STATE.user.pillBorrowed += amount;
      STATE.wallet.pillBalance += amount;
    }
    recalcHF();
  }
  if (type === 'repay') {
    const pool = STATE.ui.currentRepayPool;
    if (pool === 'moto') {
      STATE.user.motoBorrowed = Math.max(0, STATE.user.motoBorrowed - amount);
      STATE.wallet.motoBalance -= amount;
    } else if (pool === 'btc') {
      STATE.user.btcBorrowed = Math.max(0, STATE.user.btcBorrowed - amount);
      STATE.wallet.btcBalance -= amount;
    }
    recalcHF();
  }
  if (type === 'stake_pill') {
    const input = el('pill-stake-input');
    const amt = parseFloat(input?.value) || 0;
    if (amt > 0) { STATE.user.pillStaked += amt; STATE.wallet.pillBalance -= amt; }
  }
  if (type === 'unstake_pill') {
    const input = el('pill-unstake-input');
    const amt = parseFloat(input?.value) || 0;
    if (amt > 0) { STATE.user.pillStaked = Math.max(0, STATE.user.pillStaked - amt); STATE.wallet.pillBalance += amt; }
  }

  // Add to history
  addTxHistory(type, asset, amount);
}

function recalcHF() {
  const p = STATE.protocol;
  const u = STATE.user;
  const collateralUSD = u.btcDeposited * p.btcPrice + u.motoDeposited * p.motoPrice + u.pillDeposited * p.pillPrice;
  const borrowUSD     = u.motoBorrowed * p.motoPrice + u.btcBorrowed * p.btcPrice + u.pillBorrowed * p.pillPrice;
  if (borrowUSD <= 0) { u.healthFactor = 999; return; }
  const lt = u.pillStaked >= 100 ? 0.9 : 0.8;
  u.healthFactor = (collateralUSD * lt) / borrowUSD;
}

function getTxSuccessMsg(type, asset, amount) {
  const sym = { btc: 'BTC', moto: 'MOTO', pill: 'PILL' };
  if (type === 'deposit')    return `Successfully deposited ${amount} ${sym[asset] || ''}.`;
  if (type === 'withdraw')   return `Successfully withdrew ${amount} ${sym[asset] || ''}.`;
  if (type === 'borrow')     return `Successfully borrowed ${amount} ${sym[STATE.ui.currentBorrowPool] || ''}.`;
  if (type === 'repay')      return `Successfully repaid ${amount} ${sym[STATE.ui.currentRepayPool] || ''}.`;
  if (type === 'stake_pill') return 'PILL staked successfully. Protection active.';
  if (type === 'unstake_pill') return 'PILL unstaked successfully.';
  return 'Transaction confirmed.';
}

function clearInputs(type, asset) {
  const inputs = [`${asset}-deposit-input`, `${asset}-withdraw-input`, 'borrow-amount-input', 'repay-amount-input'];
  inputs.forEach(id => { const e = el(id); if (e) e.value = ''; });
}

function addTxHistory(type, asset, amount) {
  const sym = { btc: 'BTC', moto: 'MOTO', pill: 'PILL', null: '' };
  const s = sym[asset] || '';
  const now = 'Just now';
  const capitalType = type.charAt(0).toUpperCase() + type.slice(1);
  STATE.txHistory.unshift({
    type:    capitalType,
    asset:   s,
    amount:  `${amount} ${s}`.trim(),
    usd:     '',
    timeAgo: now,
    status:  'Confirmed',
    hash:    randomHash(),
  });
  if (STATE.txHistory.length > 10) STATE.txHistory.pop();
}

// ─────────────────────────────────────────────
// EARN PAGE — TABS & PREVIEWS
// ─────────────────────────────────────────────
function setEarnTab(tab) {
  STATE.ui.currentEarnTab = tab;
  document.querySelectorAll('#earn-tabs .tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.earn-tab-content').forEach(c => {
    const isActive = c.id === `earn-tab-${tab}`;
    c.classList.toggle('hidden', !isActive);
  });
  renderEarnPage();
}

function updateDepositPreview(asset) {
  const input  = el(`${asset}-deposit-input`);
  const amount = parseFloat(input?.value) || 0;

  if (asset === 'btc') {
    const p = STATE.protocol;
    const shares = p.btcTotalDeposits > 0 ? (amount * 1000) / p.btcTotalDeposits : amount;
    setText('btc-dep-shares', amount > 0 ? shares.toFixed(6) + ' shares' : '—');
    setText('btc-wallet-display', fmtBTC(STATE.wallet.btcBalance, 4));
  }
  if (asset === 'moto') {
    const shares = amount / STATE.protocol.motoTotalDeposits * 1000000;
    setText('moto-dep-shares', amount > 0 ? shares.toFixed(4) + ' shares' : '—');
  }
  if (asset === 'pill') {
    const shares = amount / STATE.protocol.pillTotalDeposits * 1000000;
    setText('pill-dep-shares', amount > 0 ? shares.toFixed(4) + ' shares' : '—');
  }
}

function updateWithdrawPreview(asset) {
  const input  = el(`${asset}-withdraw-input`);
  const amount = parseFloat(input?.value) || 0;

  if (asset === 'btc') {
    const shares = amount > 0 ? (amount * 1000 / STATE.protocol.btcTotalDeposits).toFixed(6) : '—';
    setText('btc-wd-shares', amount > 0 ? shares + ' shares' : '—');
    setText('btc-wd-output', amount > 0 ? fmtBTC(amount * 1.002, 8) : '—');
    setText('btc-deposited-display', fmtBTC(STATE.user.btcDeposited, 4));
  }
  if (asset === 'moto') {
    setText('moto-wd-shares', amount > 0 ? (amount * 0.001).toFixed(4) + ' shares' : '—');
    setText('moto-wd-output', amount > 0 ? fmtToken(amount * 1.005, 'MOTO') : '—');
  }
  if (asset === 'pill') {
    setText('pill-wd-shares', amount > 0 ? (amount * 0.001).toFixed(4) + ' shares' : '—');
    setText('pill-wd-output', amount > 0 ? fmtToken(amount * 1.003, 'PILL') : '—');
  }
}

function setMax(inputId, sourceKey) {
  const input = el(inputId);
  if (!input) return;

  const sources = {
    'btc-wallet':    STATE.wallet.btcBalance,
    'moto-wallet':   STATE.wallet.motoBalance,
    'pill-wallet':   STATE.wallet.pillBalance,
    'btc-deposited': STATE.user.btcDeposited,
    'moto-deposited':STATE.user.motoDeposited,
    'pill-deposited':STATE.user.pillDeposited,
  };
  const val = sources[sourceKey] || 0;
  input.value = val;
  input.dispatchEvent(new Event('input'));
}

// ─────────────────────────────────────────────
// BORROW PAGE
// ─────────────────────────────────────────────
function setBorrowPool(pool) {
  STATE.ui.currentBorrowPool = pool;

  document.querySelectorAll('#borrow-pool-selector .pool-sel-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.pool === pool);
  });

  const labels = { btc: 'BTC', moto: 'MOTO', pill: 'PILL' };
  setText('borrow-token-label', labels[pool] || pool.toUpperCase());

  // Collateral rule
  const rules = {
    btc:  'MOTO/PILL collateral → borrow BTC',
    moto: 'BTC collateral → borrow MOTO',
    pill: 'BTC collateral → borrow PILL',
  };
  setText('borrow-collateral-rule', rules[pool] || '');

  const collateral = {
    btc:  `${fmtToken(STATE.user.motoDeposited, 'MOTO')} + ${fmtToken(STATE.user.pillDeposited, 'PILL')}`,
    moto: fmtBTC(STATE.user.btcDeposited, 4),
    pill: fmtBTC(STATE.user.btcDeposited, 4),
  };
  setText('borrow-your-collateral', collateral[pool] || '—');

  updateBorrowMax();
  updateBorrowPreview();
}

function updateBorrowMax() {
  const pool = STATE.ui.currentBorrowPool;
  const p = STATE.protocol;
  const u = STATE.user;
  let maxSafe = 0;

  if (pool === 'moto') {
    // BTC collateral, borrow MOTO
    const collateralUSD = u.btcDeposited * p.btcPrice * 0.8;
    const existingDebtUSD = u.btcBorrowed * p.btcPrice + u.pillBorrowed * p.pillPrice;
    maxSafe = Math.max(0, (collateralUSD - existingDebtUSD) / p.motoPrice / 1.2);
  } else if (pool === 'pill') {
    const collateralUSD = u.btcDeposited * p.btcPrice * 0.8;
    const existingDebtUSD = u.motoBorrowed * p.motoPrice;
    maxSafe = Math.max(0, (collateralUSD - existingDebtUSD) / p.pillPrice / 1.2);
  } else if (pool === 'btc') {
    const collateralUSD = (u.motoDeposited * p.motoPrice + u.pillDeposited * p.pillPrice) * 0.8;
    const existingDebtUSD = u.motoBorrowed * p.motoPrice;
    maxSafe = Math.max(0, (collateralUSD - existingDebtUSD) / p.btcPrice / 1.2);
  }

  setText('borrow-max-display', pool === 'btc' ? fmtBTC(maxSafe, 6) : fmtToken(maxSafe, pool.toUpperCase()));
  const inputEl = el('borrow-amount-input');
  if (inputEl) inputEl.setAttribute('data-max', maxSafe);
}

function setBorrowMax() {
  const inputEl = el('borrow-amount-input');
  if (!inputEl) return;
  const max = parseFloat(inputEl.getAttribute('data-max')) || 0;
  inputEl.value = max.toFixed(4);
  updateBorrowPreview();
}

function updateBorrowPreview() {
  const input = el('borrow-amount-input');
  const amount = parseFloat(input?.value) || 0;
  const pool = STATE.ui.currentBorrowPool;
  const p = STATE.protocol;
  const u = STATE.user;

  if (amount <= 0) {
    setText('borrow-new-hf', '—');
    setText('borrow-new-ltv', '—');
    const badge = el('borrow-risk-badge');
    if (badge) { badge.textContent = '—'; badge.className = 'badge'; }
    return;
  }

  // Simulate new HF after borrow
  const newMotoDebt = u.motoBorrowed + (pool === 'moto' ? amount : 0);
  const newBtcDebt  = u.btcBorrowed  + (pool === 'btc'  ? amount : 0);
  const newPillDebt = u.pillBorrowed + (pool === 'pill' ? amount : 0);
  const newDebtUSD  = newMotoDebt * p.motoPrice + newBtcDebt * p.btcPrice + newPillDebt * p.pillPrice;
  const collUSD     = u.btcDeposited * p.btcPrice + u.motoDeposited * p.motoPrice + u.pillDeposited * p.pillPrice;
  const lt = u.pillStaked >= 100 ? 0.9 : 0.8;
  const newHF       = newDebtUSD > 0 ? (collUSD * lt) / newDebtUSD : 999;
  const newLTV      = collUSD > 0 ? (newDebtUSD / collUSD * 100) : 0;

  const hfEl = el('borrow-new-hf');
  if (hfEl) {
    hfEl.textContent = fmtHF(newHF);
    hfEl.style.color = hfColor(newHF);
  }
  setText('borrow-new-ltv', newLTV.toFixed(1) + '%');

  const badge = el('borrow-risk-badge');
  if (badge) {
    badge.textContent = hfRiskLabel(newHF);
    badge.className = `badge ${hfBadgeClass(newHF)}`;
  }
}

function setRepayPool(pool) {
  STATE.ui.currentRepayPool = pool;
  document.querySelectorAll('.pool-sel-btn[data-pool$="-repay"]').forEach(b => {
    b.classList.toggle('active', b.dataset.pool === pool + '-repay');
  });
  const labels = { btc: 'BTC', moto: 'MOTO', pill: 'PILL' };
  setText('repay-token-label', labels[pool] || pool.toUpperCase());
  updateRepayPreview();
}

function setRepayMax() {
  const input = el('repay-amount-input');
  if (!input) return;
  const pool = STATE.ui.currentRepayPool;
  const debts = { moto: STATE.user.motoBorrowed, btc: STATE.user.btcBorrowed, pill: STATE.user.pillBorrowed };
  input.value = (debts[pool] || 0).toFixed(4);
  updateRepayPreview();
}

function updateRepayPreview() {
  const input  = el('repay-amount-input');
  const amount = parseFloat(input?.value) || 0;
  const pool   = STATE.ui.currentRepayPool;
  const p = STATE.protocol;
  const u = STATE.user;

  if (amount <= 0) {
    setText('repay-remaining', '—');
    setText('repay-new-hf', '—');
    return;
  }

  const remaining = Math.max(0, (pool === 'moto' ? u.motoBorrowed : u.btcBorrowed) - amount);
  setText('repay-remaining', pool === 'moto' ? fmtToken(remaining, 'MOTO') : fmtBTC(remaining, 6));

  const newMotoDebt = pool === 'moto' ? Math.max(0, u.motoBorrowed - amount) : u.motoBorrowed;
  const newBtcDebt  = pool === 'btc'  ? Math.max(0, u.btcBorrowed - amount)  : u.btcBorrowed;
  const newDebtUSD  = newMotoDebt * p.motoPrice + newBtcDebt * p.btcPrice;
  const collUSD     = u.btcDeposited * p.btcPrice + u.motoDeposited * p.motoPrice;
  const lt = u.pillStaked >= 100 ? 0.9 : 0.8;
  const newHF = newDebtUSD > 0 ? (collUSD * lt) / newDebtUSD : 999;

  const hfEl = el('repay-new-hf');
  if (hfEl) {
    hfEl.textContent = fmtHF(newHF);
    hfEl.style.color = hfColor(newHF);
    hfEl.className = 'positive';
  }
}

// ─────────────────────────────────────────────
// YIELD LOOP
// ─────────────────────────────────────────────
function activateLoop(level) {
  if (!STATE.wallet.connected) { openWalletModal(); return; }
  if (STATE.user.btcDeposited <= 0) {
    showToast('No BTC Deposited', 'Deposit BTC first to activate the yield loop.', 'error');
    return;
  }

  const btnId = `lev${level}-btn`;
  setButtonLoading(btnId, true);

  showToast('Activating Loop...', `Setting up ${level}x leverage loop...`, 'pending');
  showTxModal('pending');

  setTimeout(() => {
    STATE.user.loopActive = true;
    STATE.user.loopLevel = level;

    const btcBase = STATE.user.btcDeposited;
    const loopedBTC = level === 2 ? btcBase * 0.41 : btcBase * 0.83;
    const motoBorrowed = level === 2 ? 47750 : 95500;
    const loopHF = level === 2 ? 1.62 : 1.22;

    STATE.user.motoBorrowed += motoBorrowed;
    STATE.user.btcDeposited += loopedBTC;
    STATE.user.healthFactor = loopHF;
    STATE.user.loopBTC = loopedBTC;
    STATE.user.loopMotoDebt = motoBorrowed;

    setButtonLoading(btnId, false);
    show('loop-active-banner');

    // Update banner
    setText('lab-level-badge', `${level}x Leverage`);
    setText('lab-initial-btc', fmtBTC(btcBase, 2));
    setText('lab-looped-btc', '+' + fmtBTC(loopedBTC, 2));
    setText('lab-moto-debt', fmtToken(motoBorrowed, 'MOTO', true));
    const hfEl = el('lab-hf');
    if (hfEl) { hfEl.textContent = fmtHF(loopHF); hfEl.style.color = hfColor(loopHF); }

    closeTxModal();
    showTxModal('success', { message: `${level}x leverage loop activated! Monitor your health factor.` });
    showToast('Loop Activated', `${level}x leverage is now active.`, 'success');

    renderDashboard();
  }, 2200);
}

function closeLoop() {
  if (!STATE.user.loopActive) return;

  setButtonLoading('lev2-btn', true);
  showToast('Closing Loop...', 'Unwinding position...', 'pending');
  showTxModal('pending');

  setTimeout(() => {
    // Reverse loop
    STATE.user.btcDeposited -= (STATE.user.loopBTC || 0);
    STATE.user.motoBorrowed -= (STATE.user.loopMotoDebt || 0);
    STATE.user.btcDeposited = Math.max(0.5, STATE.user.btcDeposited);
    STATE.user.motoBorrowed = Math.max(8500, STATE.user.motoBorrowed);
    STATE.user.loopActive = false;
    STATE.user.loopLevel = 0;
    STATE.user.loopBTC = 0;
    STATE.user.loopMotoDebt = 0;
    recalcHF();

    hide('loop-active-banner');
    setButtonLoading('lev2-btn', false);
    closeTxModal();
    showTxModal('success', { message: 'Loop closed. All MOTO debt repaid, BTC returned.' });
    showToast('Loop Closed', 'Position unwound successfully.', 'success');

    renderDashboard();
  }, 2000);
}

// ─────────────────────────────────────────────
// RENDER: DASHBOARD
// ─────────────────────────────────────────────
function renderDashboard() {
  const p = STATE.protocol;
  const u = STATE.user;
  const connected = STATE.wallet.connected;

  // Stat: TVL
  const tvlEl = el('stat-tvl-val');
  if (tvlEl) {
    tvlEl.innerHTML = '';
    tvlEl.style.color = '';
    animateCount(tvlEl, p.tvl, '$', '', 800, 0);
  }

  // Stat: Total Borrowed
  const borEl = el('stat-borrowed-val');
  if (borEl) {
    borEl.innerHTML = '';
    animateCount(borEl, p.totalBorrowed, '$', '', 800, 0);
  }

  // Stat: Net Worth
  const nwEl = el('stat-networth-val');
  const nwSub = el('stat-networth-sub');
  if (nwEl) {
    if (connected) {
      nwEl.innerHTML = '';
      animateCount(nwEl, u.netWorth, '$', '', 700, 2);
      if (nwSub) { nwSub.textContent = 'Deposited − Borrowed'; nwSub.className = 'stat-change positive'; }
    } else {
      nwEl.textContent = '—';
      if (nwSub) { nwSub.textContent = 'Connect wallet'; nwSub.className = 'stat-change neutral'; }
    }
  }

  // Stat: Health Factor
  const hfEl = el('stat-hf-val');
  const hfBar = el('hf-bar-fill');
  if (hfEl) {
    if (connected) {
      hfEl.innerHTML = fmtHF(u.healthFactor);
      hfEl.style.color = hfColor(u.healthFactor);
    } else {
      hfEl.innerHTML = '<span class="muted">—</span>';
      hfEl.style.color = '';
    }
  }
  if (hfBar) {
    const pct = connected ? Math.min((u.healthFactor - 1) / 2 * 100, 100) : 0;
    hfBar.style.width = pct + '%';
    hfBar.style.background = connected
      ? `linear-gradient(90deg, ${hfColor(u.healthFactor)}, ${hfColor(u.healthFactor)}cc)`
      : 'rgba(255,255,255,0.1)';
  }

  // Pool Cards user data
  if (connected) {
    // BTC
    setText('btc-user-dep', fmtBTC(u.btcDeposited, 4) + ' (' + fmtUSD(u.btcDeposited * p.btcPrice) + ')');
    const btcEarned = el('btc-user-earn');
    if (btcEarned) { btcEarned.textContent = '+' + fmtBTC(u.btcEarned, 6); btcEarned.className = 'pool-user-val positive'; }

    // MOTO
    setText('moto-user-dep', fmtToken(u.motoDeposited, 'MOTO', true) + ' (' + fmtUSD(u.motoDeposited * p.motoPrice) + ')');
    const motoEarned = el('moto-user-earn');
    if (motoEarned) { motoEarned.textContent = '+' + fmtToken(u.motoEarned, 'MOTO'); motoEarned.className = 'pool-user-val positive'; }

    // PILL
    const pillDep = el('pill-user-dep');
    if (pillDep) pillDep.textContent = u.pillDeposited > 0 ? fmtToken(u.pillDeposited, 'PILL') : '—';
    const pillEarned = el('pill-user-earn');
    if (pillEarned) { pillEarned.textContent = u.pillEarned > 0 ? '+' + fmtToken(u.pillEarned, 'PILL') : '—'; }
  } else {
    ['btc-user-dep','btc-user-earn','moto-user-dep','moto-user-earn','pill-user-dep','pill-user-earn']
      .forEach(id => setText(id, '—'));
  }
}

// ─────────────────────────────────────────────
// RENDER: EARN
// ─────────────────────────────────────────────
function renderEarnPage() {
  const u = STATE.user;
  const p = STATE.protocol;
  const connected = STATE.wallet.connected;

  const positions = {
    btc:  { dep: u.btcDeposited,  earn: u.btcEarned,  value: u.btcDeposited * (1 + 0.042/12) * p.btcPrice,  sym: 'BTC',  apy: '4.2%' },
    moto: { dep: u.motoDeposited, earn: u.motoEarned, value: u.motoDeposited * (1 + 0.068/12) * p.motoPrice, sym: 'MOTO', apy: '6.8%' },
    pill: { dep: u.pillDeposited, earn: u.pillEarned, value: u.pillDeposited * (1 + 0.051/12) * p.pillPrice,  sym: 'PILL', apy: '5.1%' },
  };

  Object.entries(positions).forEach(([asset, pos]) => {
    const fmt = asset === 'btc' ? (n) => fmtBTC(n, 4) : (n) => fmtToken(n, pos.sym);
    setText(`${asset}-pos-deposited`,  connected && pos.dep > 0 ? fmt(pos.dep) : '—');
    setText(`${asset}-pos-value`,      connected && pos.dep > 0 ? fmtUSD(pos.value) : '—');
    const earnEl = el(`${asset}-pos-earned`);
    if (earnEl) {
      earnEl.textContent = connected && pos.earn > 0 ? '+' + fmt(pos.earn) : '—';
      earnEl.className = 'pos-stat-val ' + (pos.earn > 0 ? 'positive' : '');
    }
    setText(`${asset}-pos-apy`, pos.apy);
  });

  // BTC wallet display in preview
  setText('btc-wallet-display', connected ? fmtBTC(STATE.wallet.btcBalance, 4) : '—');
  setText('btc-deposited-display', connected ? fmtBTC(u.btcDeposited, 4) : '—');
}

// ─────────────────────────────────────────────
// RENDER: PORTFOLIO
// ─────────────────────────────────────────────
function renderPortfolio() {
  const u = STATE.user;
  const p = STATE.protocol;
  const connected = STATE.wallet.connected;

  if (!connected) return;

  const totalDepUSD  = u.btcDeposited * p.btcPrice + u.motoDeposited * p.motoPrice + u.pillDeposited * p.pillPrice;
  const totalBorUSD  = u.motoBorrowed * p.motoPrice + u.btcBorrowed * p.btcPrice;
  const netEquity    = totalDepUSD - totalBorUSD;
  const claimable    = (u.btcEarned * p.btcPrice) + (u.motoEarned * p.motoPrice);

  setText('port-total-dep',   fmtUSD(totalDepUSD));
  const borEl = el('port-total-bor');
  if (borEl) { borEl.textContent = fmtUSD(totalBorUSD); borEl.style.color = 'var(--orange)'; }
  setText('port-net-equity',  fmtUSD(netEquity));
  setText('port-claimable',   fmtUSD(claimable));

  // PILL protection
  setText('ppc-staked',          u.pillStaked + ' PILL');
  const protActive = u.pillStaked >= 100;
  const statusBadge = el('ppc-status-badge');
  if (statusBadge) statusBadge.innerHTML = `<span class="badge ${protActive ? 'badge-safe' : 'badge-warning'}">${protActive ? 'Active' : 'Inactive'}</span>`;
  const statusText = el('ppc-status-text');
  if (statusText) { statusText.textContent = protActive ? 'Active' : 'Inactive'; statusText.className = 'ppc-stat-val ' + (protActive ? 'positive' : 'orange'); }
  setText('ppc-liq-threshold', protActive ? '1.1x (protected)' : '1.2x (standard)');

  // Position table
  const fmt = (n, sym, dp) => sym === 'BTC' ? fmtBTC(n, dp || 4) : fmtToken(n, sym);
  const setTd = (id, val, cls) => {
    const e = el(id);
    if (!e) return;
    e.textContent = val;
    if (cls) e.className = cls;
  };
  setTd('pt-btc-dep',   u.btcDeposited > 0  ? fmtBTC(u.btcDeposited, 4)     : '—');
  setTd('pt-btc-bor',   u.btcBorrowed > 0   ? fmtBTC(u.btcBorrowed, 6)      : '—', 'orange');
  setTd('pt-btc-earn',  u.btcEarned > 0     ? '+' + fmtBTC(u.btcEarned, 6)  : '—', 'positive');
  setTd('pt-moto-dep',  u.motoDeposited > 0 ? fmtToken(u.motoDeposited, 'MOTO') : '—');
  setTd('pt-moto-bor',  u.motoBorrowed > 0  ? fmtToken(u.motoBorrowed, 'MOTO') : '—', 'orange');
  setTd('pt-moto-earn', u.motoEarned > 0    ? '+' + fmtToken(u.motoEarned, 'MOTO') : '—', 'positive');
  setTd('pt-pill-dep',  u.pillDeposited > 0 ? fmtToken(u.pillDeposited, 'PILL') : '—');
  setTd('pt-pill-bor',  u.pillBorrowed > 0  ? fmtToken(u.pillBorrowed, 'PILL') : '—', 'orange');
  setTd('pt-pill-earn', u.pillEarned > 0    ? '+' + fmtToken(u.pillEarned, 'PILL') : '—', 'positive');

  renderTxHistory();
}

function renderTxHistory() {
  const container = el('tx-history');
  if (!container) return;

  if (STATE.txHistory.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:32px;color:var(--text-muted)">
        No transactions yet. Start by depositing tokens.
      </div>`;
    return;
  }

  const typeClass = { Deposit: 'tx-deposit', Borrow: 'tx-borrow', Repay: 'tx-repay', Withdraw: 'tx-withdraw' };

  container.innerHTML = STATE.txHistory.map(tx => `
    <div class="tx-item">
      <span class="tx-type-badge ${typeClass[tx.type] || 'tx-deposit'}">${tx.type}</span>
      <div class="tx-info">
        <div class="tx-amount">${tx.amount}${tx.usd ? ' · ' + tx.usd : ''}</div>
        <div class="tx-time">${tx.timeAgo}</div>
      </div>
      <span class="tx-hash-short">${tx.hash}...</span>
      <span class="tx-status ${tx.status === 'Confirmed' ? 'tx-confirmed' : 'tx-pending'}">${tx.status}</span>
    </div>
  `).join('');
}

// ─────────────────────────────────────────────
// RENDER: CURRENT PAGE
// ─────────────────────────────────────────────
function renderCurrentPage() {
  const page = STATE.ui.currentPage;
  if (page === 'dashboard') renderDashboard();
  if (page === 'earn')      renderEarnPage();
  if (page === 'portfolio') renderPortfolio();
  if (page === 'borrow')    renderBorrowPage();
}

function renderBorrowPage() {
  const u = STATE.user;
  const p = STATE.protocol;

  setText('repay-moto-debt', fmtToken(u.motoBorrowed, 'MOTO'));
  setText('repay-btc-debt', fmtBTC(u.btcBorrowed, 6));
  setText('repay-total-usd', fmtUSD(u.motoBorrowed * p.motoPrice + u.btcBorrowed * p.btcPrice));
  updateBorrowMax();
}

// ─────────────────────────────────────────────
// AUTO-REFRESH (every 30s)
// ─────────────────────────────────────────────
let refreshInterval = null;

function startAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(() => {
    simulatePriceFluctuation();
    renderCurrentPage();
    pulseStats();
    updateLastRefreshNote();
  }, 30000);
}

function simulatePriceFluctuation() {
  // Small random drift to simulate live data
  const drift = () => 1 + (Math.random() - 0.5) * 0.003;
  STATE.protocol.btcPrice   *= drift();
  STATE.protocol.motoPrice  *= drift();
  STATE.protocol.pillPrice  *= drift();
  STATE.protocol.tvl *= (1 + (Math.random() - 0.47) * 0.002);

  // Accrue tiny interest
  STATE.user.btcEarned  += STATE.user.btcDeposited * 0.042 / (365 * 24 * 120);
  STATE.user.motoEarned += STATE.user.motoDeposited * 0.068 / (365 * 24 * 120);
}

function pulseStats() {
  document.querySelectorAll('.stat-card').forEach(card => {
    card.classList.remove('stats-pulse');
    void card.offsetWidth; // reflow
    card.classList.add('stats-pulse');
    setTimeout(() => card.classList.remove('stats-pulse'), 800);
  });
}

function updateLastRefreshNote() {
  const el = document.getElementById('last-refresh-note');
  if (el) el.textContent = 'Updated just now';
  setTimeout(() => { if (el) el.textContent = 'Live data'; }, 3000);
}

// ─────────────────────────────────────────────
// INITIAL DATA LOAD WITH SKELETON FADE-OUT
// ─────────────────────────────────────────────
function initDataLoad() {
  // Simulate 1s data load for skeleton
  setTimeout(() => {
    renderDashboard();

    // Replace skeletons
    document.querySelectorAll('.skeleton-text').forEach(s => {
      s.parentElement && s.parentElement.classList.add('count-up-done');
      s.remove();
    });
  }, 1100);
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Initial page
  navigateTo('dashboard');

  // Load data with skeleton delay
  initDataLoad();

  // Start auto-refresh
  startAutoRefresh();

  // Initial borrow pool setup
  setBorrowPool('moto');
  setRepayPool('moto');

  // Render TX history on load
  renderTxHistory();

  // Close dropdown on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeWalletDropdown();
      closeWalletModal();
      closeTxModal();
    }
  });

  // Animate loop page leverage stats on static btc base
  updateLeverageCards();
});

function updateLeverageCards() {
  const btcBase = STATE.user.btcDeposited;
  const btcPrice = STATE.protocol.btcPrice;
  const motoPrice = STATE.protocol.motoPrice;

  // 2x: borrow 50% of BTC value in MOTO
  const moto2x = (btcBase * btcPrice * 0.5) / motoPrice;
  const btcAdded2x = moto2x * motoPrice / btcPrice * 0.98; // 2% slippage
  const totalColl2x = btcBase + btcAdded2x;
  const hf2x = (totalColl2x * btcPrice * 0.8) / (moto2x * motoPrice);

  setText('lev2-collateral', fmtBTC(totalColl2x, 2));
  setText('lev2-moto', fmtToken(Math.round(moto2x), 'MOTO', true));
  const hf2El = el('lev2-hf');
  if (hf2El) { hf2El.textContent = '~' + hf2x.toFixed(2); hf2El.style.color = hfColor(hf2x); }

  // 3x: borrow 67% of BTC value
  const moto3x = (btcBase * btcPrice * 0.67) / motoPrice;
  const btcAdded3x = moto3x * motoPrice / btcPrice * 0.98;
  const totalColl3x = btcBase + btcAdded3x;
  const hf3x = (totalColl3x * btcPrice * 0.8) / (moto3x * motoPrice);

  setText('lev3-collateral', fmtBTC(totalColl3x, 2));
  setText('lev3-moto', fmtToken(Math.round(moto3x), 'MOTO', true));
  const hf3El = el('lev3-hf');
  if (hf3El) { hf3El.textContent = '~' + hf3x.toFixed(2); hf3El.style.color = hfColor(hf3x); }

  // 1x
  setText('lev1-collateral', fmtBTC(btcBase, 2));
  setText('lev1-moto', '0 MOTO');
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL CONTRACT INTEGRATION (overrides mock functions above)
// ─────────────────────────────────────────────────────────────────────────────

// Lazy SDK getter — bundle.js may finish loading after this script runs
function getSDK() { return window.LendBTCSDK ?? null; }

// Detect OPWallet under any known global name
function getOPWallet() {
  return window.opnet ?? window.bitcoin ?? window.OPWallet ?? window.opnetWallet ?? null;
}

async function loadContractData(userAddress) {
  const SDK = getSDK();
  if (!SDK) return; // SDK not loaded — keep mock data

  try {
    // Load protocol-wide pool rates
    const rates = await SDK.contract.getAllPoolRates();
    STATE.protocol.btcTotalDeposits  = rates.btc.totalDeposits;
    STATE.protocol.btcTotalBorrowed  = rates.btc.totalBorrowed;
    STATE.protocol.btcSupplyAPR      = rates.btc.supplyAPR;
    STATE.protocol.btcBorrowAPR      = rates.btc.borrowAPR;
    STATE.protocol.btcUtilization    = rates.btc.utilization;
    STATE.protocol.motoTotalDeposits = rates.moto.totalDeposits;
    STATE.protocol.motoTotalBorrowed = rates.moto.totalBorrowed;
    STATE.protocol.motoSupplyAPR     = rates.moto.supplyAPR;
    STATE.protocol.motoBorrowAPR     = rates.moto.borrowAPR;
    STATE.protocol.motoUtilization   = rates.moto.utilization;
    STATE.protocol.pillTotalDeposits = rates.pill.totalDeposits;
    STATE.protocol.pillTotalBorrowed = rates.pill.totalBorrowed;
    STATE.protocol.pillSupplyAPR     = rates.pill.supplyAPR;
    STATE.protocol.pillBorrowAPR     = rates.pill.borrowAPR;
    STATE.protocol.pillUtilization   = rates.pill.utilization;
  } catch (e) { console.warn('Pool rates load failed:', e.message); }

  if (!userAddress) return;

  try {
    // Load user vault
    const vault = await SDK.contract.getVault(userAddress);
    STATE.user.btcDeposited  = vault.btcBalance;
    STATE.user.motoDeposited = vault.motoBalance;
    STATE.user.pillDeposited = vault.pillBalance;
    STATE.user.motoBorrowed  = vault.motoDebt;
    STATE.user.btcBorrowed   = vault.btcDebt;
    STATE.user.pillBorrowed  = vault.pillDebt;
    STATE.user.healthFactor  = vault.healthFactor;
  } catch (e) { console.warn('Vault load failed:', e.message); }

  try {
    // Load deposit positions (for earned interest)
    const pos = await SDK.contract.getAllDepositPositions(userAddress);
    STATE.user.btcEarned  = pos.btc.earnedInterest;
    STATE.user.motoEarned = pos.moto.earnedInterest;
    STATE.user.pillEarned = pos.pill.earnedInterest;
  } catch (e) { console.warn('Deposit positions load failed:', e.message); }

  try {
    // Load PILL protection
    const pill = await SDK.contract.getPillProtection(userAddress);
    STATE.user.pillStaked    = pill.pillStaked;
    STATE.user.pillProtected = pill.protectionActive;
    STATE.user.liqThreshold  = pill.liqThreshold;
  } catch (e) { console.warn('PILL protection load failed:', e.message); }

  try {
    // Load loop metrics
    const loop = await SDK.contract.getLoopMetrics(userAddress);
    STATE.user.loopActive = loop.isActive;
    STATE.user.loopLevel  = loop.loopLevel;
  } catch (e) { console.warn('Loop metrics load failed:', e.message); }

  // Recalculate net worth
  const btcUSD  = STATE.user.btcDeposited  * STATE.protocol.btcPrice;
  const motoUSD = STATE.user.motoDeposited * STATE.protocol.motoPrice;
  const pillUSD = STATE.user.pillDeposited * STATE.protocol.pillPrice;
  const debtUSD = STATE.user.motoBorrowed  * STATE.protocol.motoPrice
                + STATE.user.btcBorrowed   * STATE.protocol.btcPrice
                + STATE.user.pillBorrowed  * STATE.protocol.pillPrice;
  STATE.user.netWorth = btcUSD + motoUSD + pillUSD - debtUSD;
}

// Manual address connect (read-only mode for localhost / no-extension scenarios)
window.connectManualAddress = async function() {
  const input = document.getElementById('manual-address-input');
  const address = input?.value?.trim();
  if (!address || address.length < 10) {
    showToast('Invalid Address', 'Paste your full OP_NET address (opt1p...)', 'error');
    return;
  }

  hide('wallet-modal');
  showToast('Loading...', 'Reading your on-chain positions...', 'pending');

  STATE.wallet.connected    = true;
  STATE.wallet.address      = address;
  STATE.wallet.shortAddress = shortenAddress(address);
  STATE.wallet.btcBalance   = 0;
  STATE.wallet.readOnly     = true;

  hide('btn-connect');
  hide('btn-connect-mobile');
  show('wallet-connected');
  show('wallet-connected-mobile');

  const shortEl  = el('wallet-address-short');
  const shortMob = el('wallet-address-short-mobile');
  if (shortEl)  shortEl.textContent  = STATE.wallet.shortAddress + ' (view)';
  if (shortMob) shortMob.textContent = STATE.wallet.shortAddress + ' (view)';

  const fullAddr = el('wallet-full-address');
  if (fullAddr) fullAddr.textContent = address;

  await loadContractData(address);
  renderCurrentPage();
  showToast('Connected (Read-only)', 'Showing your real on-chain data', 'success');
};

// Override connectWallet — directly uses OPWallet, no SDK dependency
window.connectWallet = async function(type) {
  hide('wallet-modal');
  showToast('Connecting...', `Connecting to ${type === 'opwallet' ? 'OPWallet' : type}...`, 'pending');

  // Wait a tick so extension has time to inject
  await new Promise(r => setTimeout(r, 300));

  const wallet = getOPWallet();

  if (!wallet) {
    // No extension injected — re-open modal and focus the paste input
    show('wallet-modal');
    showToast('Paste Your Address', 'OPWallet not detected on this page. Paste your address below to view your positions.', 'error');
    setTimeout(() => {
      const input = document.getElementById('manual-address-input');
      if (input) { input.focus(); input.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }, 100);
    return;
  }

  try {
    const accounts = await wallet.requestAccounts();
    if (!accounts?.length) throw new Error('No accounts returned from wallet');

    const address = accounts[0];

    // Get balance — some wallets return sats as bigint, number, or object
    let btcBalance = 0;
    try {
      const bal = await wallet.getBalance();
      const raw = bal?.total ?? bal?.confirmed ?? bal ?? 0;
      btcBalance = Number(raw) / 1e8;
    } catch (_) {}

    // Update state
    STATE.wallet.connected    = true;
    STATE.wallet.address      = address;
    STATE.wallet.shortAddress = shortenAddress(address);
    STATE.wallet.btcBalance   = btcBalance;

    // Update nav UI
    hide('btn-connect');
    hide('btn-connect-mobile');
    show('wallet-connected');
    show('wallet-connected-mobile');

    const shortEl  = el('wallet-address-short');
    const shortMob = el('wallet-address-short-mobile');
    if (shortEl)  shortEl.textContent  = STATE.wallet.shortAddress;
    if (shortMob) shortMob.textContent = STATE.wallet.shortAddress;

    const balEl = el('wallet-btc-bal');
    if (balEl) balEl.textContent = btcBalance.toFixed(4) + ' BTC';

    const fullAddr = el('wallet-full-address');
    const wdBal    = el('wd-btc-balance');
    if (fullAddr) fullAddr.textContent = address;
    if (wdBal)    wdBal.textContent    = fmtBTC(btcBalance, 4);

    showToast('Wallet Connected', `Connected: ${shortenAddress(address)}`, 'success');

    // Load real on-chain data
    await loadContractData(address);
    renderCurrentPage();
  } catch (e) {
    console.error('Wallet connect failed:', e);
    showToast('Connection Failed', e.message || 'Wallet connection failed', 'error');
  }
};

// Override submitTransaction to use real contract calls
const _origSubmitTransaction = window.submitTransaction ?? submitTransaction;
window.submitTransaction = async function(type, asset) {
  const SDK = getSDK();
  if (!SDK || !STATE.wallet.connected) { _origSubmitTransaction(type, asset); return; }

  const CONTRACT_ADDR = SDK.CONTRACT_ADDRESS;
  let encoded;

  try {
    // Determine token pool
    const poolMap = { 'BTC': SDK.POOL_BTC, 'MOTO': SDK.POOL_MOTO, 'PILL': SDK.POOL_PILL };
    const pool = poolMap[asset] ?? SDK.POOL_MOTO;

    // Get amount from active input
    const amountInput = document.querySelector('.amount-input:not([disabled])');
    const amountStr = amountInput?.value ?? '0';
    const amount = parseFloat(amountStr);
    // Convert to token units (8 decimals)
    const amountUnits = BigInt(Math.round(amount * 1e8));

    switch (type) {
      case 'deposit':  encoded = await SDK.contract.encodeDeposit(pool, amountUnits); break;
      case 'withdraw': encoded = await SDK.contract.encodeWithdraw(pool, amountUnits); break;
      case 'borrow':   encoded = await SDK.contract.encodeBorrow(pool, amountUnits); break;
      case 'repay':    encoded = await SDK.contract.encodeRepay(pool, amountUnits); break;
      case 'stake':    encoded = await SDK.contract.encodeStakePill(amountUnits); break;
      case 'unstake':  encoded = await SDK.contract.encodeUnstakePill(amountUnits); break;
      case 'openLoop': {
        const levelSel = document.querySelector('.loop-level-select');
        const level = parseInt(levelSel?.value ?? '2');
        encoded = await SDK.contract.encodeOpenLoop(level);
        break;
      }
      case 'closeLoop': encoded = await SDK.contract.encodeCloseLoop(); break;
      default: _origSubmitTransaction(type, asset); return;
    }
  } catch (e) {
    console.error('Encoding failed:', e);
    _origSubmitTransaction(type, asset);
    return;
  }

  // Show pending state
  showTxModal('pending', { type, asset });
  showToast('Transaction Submitted', `${type} transaction sent to OPNet.`, 'pending');

  try {
    const result = await SDK.sendInteraction(encoded.calldata, CONTRACT_ADDR);

    const explorerLink = result.simulated
      ? '#'
      : `${SDK.EXPLORER_URL}/${result.txHash}`;

    showTxModal('success', {
      type, asset,
      txHash: result.txHash,
      explorerLink,
    });
    showToast(
      'Transaction Confirmed',
      result.simulated ? 'Simulated transaction confirmed.' : 'On-chain transaction confirmed!',
      'success'
    );

    // Refresh data
    await loadContractData(STATE.wallet.address);
    renderCurrentPage();
  } catch (e) {
    showTxModal('error', { type, asset, error: e.message });
    showToast('Transaction Failed', e.message, 'error');
  }
};

// Load protocol data on page load (no wallet needed for public reads)
(async function initContractData() {
  // Wait for bundle.js to finish loading
  await new Promise(r => setTimeout(r, 500));
  if (!getSDK()) return;
  try {
    await loadContractData(null);
    renderCurrentPage();
  } catch (e) {
    console.warn('Initial contract data load failed, using mock data:', e.message);
  }
})();
