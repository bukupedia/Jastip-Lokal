/* ============================================================================
 * js/admin.js — Phase 4 admin panel
 * Loaded after js/config.js. Exposes globals: AdminApi, AdminStore, AdminUI,
 * AdminApp.
 *
 * Modules:
 *   1. AdminApi   — the only place that talks to Supabase
 *   2. AdminStore — session + data snapshot, tiny pub/sub
 *   3. AdminUI    — rendering only, never mutates data
 *   4. AdminApp   — auth flow, event wiring, validation
 *
 * Security notes:
 *   - Only the anon key is used. Every read/write is gated by the RLS policies
 *     in supabase/schema.sql, which grant write access to `authenticated` only.
 *   - Database values are rendered with textContent (or created nodes), never
 *     innerHTML, so product names / customer input can never inject markup.
 *   - The dashboard element keeps the `inert` attribute and is cleared on
 *     sign-out, so an expired session cannot leave PII on screen.
 * ==========================================================================*/

'use strict';

/* Must mirror the CHECK constraint on public.orders.status. */
const ORDER_STATUS_LABELS = Object.freeze({
  PENDING_DP: 'Menunggu DP',
  DP_PAID: 'DP Dikonfirmasi',
  PURCHASED: 'Barang Dibeli',
  SHIPPED: 'Dikirim',
  COMPLETED: 'Selesai',
  CANCELLED: 'Dibatalkan',
});

/** Primary happy path shown by the "next step" button. */
const ORDER_STATUS_FLOW = Object.freeze(['PENDING_DP', 'DP_PAID', 'PURCHASED', 'COMPLETED']);

/** Every value the select offers, in workflow order. */
const ORDER_STATUS_ORDER = Object.freeze([
  'PENDING_DP', 'DP_PAID', 'PURCHASED', 'SHIPPED', 'COMPLETED', 'CANCELLED',
]);

/* ==========================================================================
 * 1. API (Supabase service)
 * ==========================================================================*/
const AdminApi = (() => {
  let client = null;

  const getClient = () => {
    if (client) return client;
    if (!isConfigReady()) throw new Error('Supabase belum dikonfigurasi di js/config.js.');
    if (!window.supabase?.createClient) {
      throw new Error('Pustaka Supabase gagal dimuat. Periksa koneksi lalu muat ulang halaman.');
    }
    client = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    return client;
  };

  /* ------------------------------------------------------------------ auth */
  const getSession = async () => {
    const { data, error } = await getClient().auth.getSession();
    if (error) throw error;
    return data?.session ?? null;
  };

  const signIn = async (email, password) => {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data?.session ?? null;
  };

  const signOut = async () => {
    const { error } = await getClient().auth.signOut();
    if (error) throw error;
  };

  /** @param {(event: string, session: object|null) => void} handler */
  const onAuthChange = (handler) => {
    const { data } = getClient().auth.onAuthStateChange((event, session) => handler(event, session));
    return data?.subscription ?? null;
  };

  /* ------------------------------------------------------------------ trip */
  const TRIP_COLUMNS =
    'id, destination_city, is_open, close_date, arrival_estimate, dp_percentage, admin_whatsapp';

  const fetchTrip = async () => {
    const { data, error } = await getClient()
      .from('trip_settings')
      .select(TRIP_COLUMNS)
      .eq('id', CONFIG.TRIP_SETTINGS_ID)
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  };

  const saveTrip = async (patch) => {
    const { data, error } = await getClient()
      .from('trip_settings')
      .update(patch)
      .eq('id', CONFIG.TRIP_SETTINGS_ID)
      .select(TRIP_COLUMNS)
      .single();
    if (error) throw error;
    return data;
  };

  /* -------------------------------------------------------------- products */
  const PRODUCT_COLUMNS =
    'id, name, category, store_location, price, jastip_fee, quota_available, image_url, created_at';

  const fetchProducts = async () => {
    const { data, error } = await getClient()
      .from('products')
      .select(PRODUCT_COLUMNS)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  };

  const createProduct = async (row) => {
    const { data, error } = await getClient()
      .from('products')
      .insert(row)
      .select(PRODUCT_COLUMNS)
      .single();
    if (error) throw error;
    return data;
  };

  const updateProduct = async (id, row) => {
    const { data, error } = await getClient()
      .from('products')
      .update(row)
      .eq('id', id)
      .select(PRODUCT_COLUMNS)
      .single();
    if (error) throw error;
    return data;
  };

  const deleteProduct = async (id) => {
    const { error } = await getClient().from('products').delete().eq('id', id);
    if (error) throw error;
  };

  /* ---------------------------------------------------------------- orders */
  const ORDER_SELECT =
    'id, order_code, customer_name, customer_wa, shipping_address, courier, total_amount, ' +
    'dp_amount, remaining_amount, status, created_at, ' +
    'order_items(id, product_id, quantity, notes, price_at_purchase, fee_at_purchase)';

  const fetchOrders = async () => {
    const { data, error } = await getClient()
      .from('orders')
      .select(ORDER_SELECT)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  };

  const updateOrderStatus = async (id, status) => {
    const { data, error } = await getClient()
      .from('orders')
      .update({ status })
      .eq('id', id)
      .select('id, status')
      .single();
    if (error) throw error;
    return data;
  };

  return {
    getClient,
    getSession, signIn, signOut, onAuthChange,
    fetchTrip, saveTrip,
    fetchProducts, createProduct, updateProduct, deleteProduct,
    fetchOrders, updateOrderStatus,
  };
})();

/* ==========================================================================
 * 2. STORE (state management)
 * ==========================================================================*/
const AdminStore = (() => {
  const listeners = new Set();

  const state = {
    session: null,
    trip: null,
    products: [],
    orders: [],
    editingId: null,
    loaded: false,
  };

  const get = () => state;

  const set = (patch) => {
    Object.assign(state, patch);
    listeners.forEach((listener) => {
      try {
        listener(state);
      } catch (error) {
        console.error('[AdminStore] listener failed', error);
      }
    });
  };

  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const reset = () => set({ session: null, trip: null, products: [], orders: [], editingId: null, loaded: false });

  return { get, set, subscribe, reset };
})();

/* ==========================================================================
 * 3. UI (rendering only)
 * ==========================================================================*/
const AdminUI = (() => {
  const els = {};
  let editingKey = '';
  let lastFocused = null;

  const TOAST_STYLES = {
    success: 'fa-circle-check text-emerald-600',
    error: 'fa-circle-exclamation text-rose-600',
    info: 'fa-circle-info text-brand-600',
  };

  const cacheElements = () => {
    const ids = [
      'admin-boot', 'config-error', 'auth-view',
      'login-form', 'login-email', 'login-password', 'login-toggle-password',
      'login-error', 'login-error-text', 'login-submit', 'login-submit-spinner', 'login-submit-label',
      'admin-app', 'admin-email', 'logout-button', 'orders-count', 'admin-main',
      'panel-trip', 'trip-form', 'trip-state-pill', 'trip-city', 'trip-dp', 'trip-close',
      'trip-arrival', 'trip-wa', 'trip-open', 'trip-submit', 'trip-submit-spinner',
      'trip-submit-label', 'trip-saved-at',
      'panel-produk', 'product-form', 'product-form-title', 'product-cancel', 'product-id',
      'product-name', 'product-category', 'product-store', 'product-price', 'product-fee',
      'product-quota', 'product-image', 'product-error', 'product-error-text',
      'product-submit', 'product-submit-spinner', 'product-submit-label',
      'products-count', 'products-body', 'products-empty',
      'panel-pesanan', 'orders-refresh', 'orders-error', 'orders-error-text',
      'orders-body', 'orders-empty', 'toast-region',
    ];

    ids.forEach((id) => {
      els[id.replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = document.getElementById(id);
    });

    els.tplProductRow = document.getElementById('tpl-product-row');
    els.tplOrderRow = document.getElementById('tpl-order-row');
    els.tabs = Array.from(document.querySelectorAll('[data-tab]'));
    els.panels = { trip: els.panelTrip, produk: els.panelProduk, pesanan: els.panelPesanan };
  };

  /* --------------------------------------------------------------- phases */
  const showPhase = (phase) => {
    els.adminBoot?.classList.toggle('hidden', phase !== 'boot');
    els.configError?.classList.toggle('hidden', phase !== 'config');

    const authVisible = phase === 'auth';
    els.authView?.classList.toggle('hidden', !authVisible);
    els.authView?.classList.toggle('grid', authVisible);

    const appVisible = phase === 'app';
    els.adminApp?.classList.toggle('hidden', !appVisible);
    if (els.adminApp) {
      els.adminApp.toggleAttribute('inert', !appVisible);
      els.adminApp.setAttribute('aria-hidden', String(!appVisible));
    }

    if (authVisible) window.setTimeout(() => els.loginEmail?.focus(), 60);
  };

  const selectTab = (name) => {
    Object.entries(els.panels).forEach(([key, panel]) => panel?.classList.toggle('hidden', key !== name));
    els.tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.tab === name)));
  };

  /* ---------------------------------------------------------------- login */
  const setLoginBusy = (busy) => {
    if (els.loginSubmit) {
      els.loginSubmit.disabled = busy;
      els.loginSubmit.setAttribute('aria-busy', String(busy));
    }
    els.loginSubmitSpinner?.classList.toggle('hidden', !busy);
    if (els.loginSubmitLabel) els.loginSubmitLabel.textContent = busy ? 'Memeriksa…' : 'Masuk ke panel';
  };

  const showLoginError = (message) => {
    const text = String(message ?? '').trim();
    els.loginError?.classList.toggle('hidden', !text);
    if (els.loginErrorText) els.loginErrorText.textContent = text;
  };

  const setSessionEmail = (email) => {
    if (els.adminEmail) els.adminEmail.textContent = String(email ?? '');
  };

  /* ----------------------------------------------------------------- trip */
  const toLocalInput = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const renderTripState = (trip) => {
    if (!els.tripStatePill) return;
    const closedByDate = trip?.close_date ? new Date(trip.close_date).getTime() <= Date.now() : false;
    const open = Boolean(trip?.is_open) && !closedByDate;
    els.tripStatePill.textContent = open ? 'PO Dibuka' : 'PO Ditutup';
    els.tripStatePill.className = `badge ${open ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`;
  };

  const fillTripForm = (trip) => {
    if (!trip) return;
    els.tripCity.value = String(trip.destination_city ?? '');
    els.tripDp.value = String(clampInt(trip.dp_percentage ?? 50, 0, 100));
    els.tripClose.value = toLocalInput(trip.close_date);
    els.tripArrival.value = String(trip.arrival_estimate ?? '');
    els.tripWa.value = String(trip.admin_whatsapp ?? '');
    els.tripOpen.checked = Boolean(trip.is_open);
    renderTripState(trip);
  };

  const setTripBusy = (busy) => {
    if (els.tripSubmit) {
      els.tripSubmit.disabled = busy;
      els.tripSubmit.setAttribute('aria-busy', String(busy));
    }
    els.tripSubmitSpinner?.classList.toggle('hidden', !busy);
    if (els.tripSubmitLabel) els.tripSubmitLabel.textContent = busy ? 'Menyimpan…' : 'Simpan pengaturan';
  };

  const setTripSavedAt = (date) => {
    if (els.tripSavedAt) els.tripSavedAt.textContent = date ? `Terakhir disimpan ${formatDateTimeId(date)}` : '';
  };

  /* -------------------------------------------------------------- products */
  const renderCategoryOptions = () => {
    if (!els.productCategory || els.productCategory.options.length > 0) return;
    els.productCategory.replaceChildren(
      ...CATEGORIES.filter((item) => item.value !== 'all').map((item) => {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        return option;
      })
    );
  };

  const editingId = () => editingKey;

  const renderProductForm = (product) => {
    const editing = Boolean(product?.id);
    editingKey = editing ? String(product.id) : '';

    els.productId.value = editing ? String(product.id) : '';
    els.productFormTitle.textContent = editing ? 'Ubah Produk' : 'Tambah Produk';
    els.productSubmitLabel.textContent = editing ? 'Simpan perubahan' : 'Tambah produk';
    els.productCancel.classList.toggle('hidden', !editing);

    els.productName.value = editing ? String(product.name ?? '') : '';
    els.productCategory.value = editing ? String(product.category ?? 'Kuliner') : 'Kuliner';
    els.productStore.value = editing ? String(product.store_location ?? '') : '';
    els.productPrice.value = editing ? String(Math.trunc(Number(product.price) || 0)) : '';
    els.productFee.value = editing ? String(Math.trunc(Number(product.jastip_fee) || 0)) : '';
    els.productQuota.value = editing ? String(Math.trunc(Number(product.quota_available) || 0)) : '';
    els.productImage.value = editing ? String(product.image_url ?? '') : '';

    showProductError('');
  };

  const showProductError = (message) => {
    const text = String(message ?? '').trim();
    els.productError?.classList.toggle('hidden', !text);
    if (els.productErrorText) els.productErrorText.textContent = text;
  };

  const setProductBusy = (busy) => {
    if (els.productSubmit) {
      els.productSubmit.disabled = busy;
      els.productSubmit.setAttribute('aria-busy', String(busy));
    }
    els.productSubmitSpinner?.classList.toggle('hidden', !busy);
    const editing = Boolean(editingKey);
    if (els.productSubmitLabel) {
      els.productSubmitLabel.textContent = busy
        ? 'Menyimpan…'
        : editing
          ? 'Simpan perubahan'
          : 'Tambah produk';
    }
  };

  const buildProductRow = (product) => {
    const row = els.tplProductRow.content.firstElementChild.cloneNode(true);
    row.dataset.id = String(product.id);

    const name = String(product.name ?? '').trim() || 'Tanpa nama';
    row.querySelector('[data-name]').textContent = name;
    row.querySelector('[data-meta]').textContent = [product.category, product.store_location]
      .map((part) => String(part ?? '').trim())
      .filter(Boolean)
      .join(' · ');
    row.querySelector('[data-price]').textContent = formatRupiah(product.price);
    row.querySelector('[data-fee]').textContent = formatRupiah(product.jastip_fee);

    const quota = Math.max(0, Math.trunc(Number(product.quota_available) || 0));
    const badge = row.querySelector('[data-quota]');
    badge.textContent = String(quota);
    badge.dataset.state = quota === 0 ? 'empty' : quota <= 3 ? 'low' : 'ok';

    row.querySelector('[data-action="edit"]').setAttribute('aria-label', `Ubah ${name}`);
    row.querySelector('[data-action="delete"]').setAttribute('aria-label', `Hapus ${name}`);
    return row;
  };

  const renderProducts = (products) => {
    const list = Array.isArray(products) ? products : [];
    els.productsEmpty?.classList.toggle('hidden', list.length > 0);
    if (els.productsCount) {
      els.productsCount.textContent = list.length
        ? `${list.length} produk · ${list.reduce((sum, item) => sum + Math.max(0, Math.trunc(Number(item.quota_available) || 0)), 0)} kuota`
        : '';
    }

    const fragment = document.createDocumentFragment();
    list.forEach((product) => fragment.append(buildProductRow(product)));
    els.productsBody.replaceChildren(fragment);
  };

  /* ---------------------------------------------------------------- orders */
  const nextStatus = (status) => {
    const index = ORDER_STATUS_FLOW.indexOf(status);
    return index >= 0 && index < ORDER_STATUS_FLOW.length - 1 ? ORDER_STATUS_FLOW[index + 1] : '';
  };

  const buildContactLink = (order, digits) => {
    const firstName = String(order.customer_name ?? '').trim().split(/\s+/)[0] || 'Kak';
    const code = String(order.order_code ?? '');
    const total = formatRupiah(order.total_amount);
    const dp = formatRupiah(order.dp_amount);
    const remaining = formatRupiah(order.remaining_amount);

    let message;
    switch (order.status) {
      case 'PENDING_DP':
        message = `Halo ${firstName}, pesanan ${code} sudah kami terima. Total ${total} dengan DP ${dp}. Mohon transfer DP lalu kirim bukti transfernya di chat ini ya. Terima kasih!`;
        break;
      case 'DP_PAID':
      case 'PURCHASED':
      case 'SHIPPED':
        message = `Halo ${firstName}, update pesanan ${code}: barang sudah kami amankan. Sisa pelunasan ${remaining}. Mohon transfer sisa pembayaran lalu kirim buktinya di chat ini ya. Terima kasih!`;
        break;
      case 'COMPLETED':
        message = `Halo ${firstName}, pesanan ${code} sudah selesai. Terima kasih sudah titip beli di Jastip Lokal!`;
        break;
      default:
        message = `Halo ${firstName}, kami ingin mengonfirmasi pesanan ${code}.`;
    }

    return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
  };

  const buildOrderRow = (order, productsById) => {
    const row = els.tplOrderRow.content.firstElementChild.cloneNode(true);
    row.dataset.id = String(order.id);

    row.querySelector('[data-code]').textContent = String(order.order_code ?? '—');
    row.querySelector('[data-date]').textContent = formatDateTimeId(order.created_at);
    row.querySelector('[data-courier]').textContent = `Kurir: ${String(order.courier ?? '—')}`;
    row.querySelector('[data-customer]').textContent = String(order.customer_name ?? '—');
    row.querySelector('[data-address]').textContent = String(order.shipping_address ?? '');

    const digits = normalizePhoneId(order.customer_wa);
    const waLink = row.querySelector('[data-wa]');
    waLink.textContent = digits ? `+${digits}` : String(order.customer_wa ?? '');
    waLink.href = digits ? `https://wa.me/${digits}` : '#';

    const items = Array.isArray(order.order_items) ? order.order_items : [];
    const pieces = items.reduce((sum, item) => sum + Math.max(0, Math.trunc(Number(item.quantity) || 0)), 0);
    row.querySelector('[data-items-summary]').textContent = `${items.length} produk · ${pieces} pcs`;

    const itemList = row.querySelector('[data-items]');
    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      const product = productsById.get(item.product_id);
      const li = document.createElement('li');

      const label = document.createElement('span');
      label.className = 'font-semibold text-slate-700';
      label.textContent = `${product?.name ?? 'Produk dihapus'} × ${item.quantity}`;
      li.append(label);

      const unit = Math.max(0, Math.trunc(Number(item.price_at_purchase) || 0))
        + Math.max(0, Math.trunc(Number(item.fee_at_purchase) || 0));
      const price = document.createElement('span');
      price.className = 'ml-1 text-slate-500';
      price.textContent = `(${formatRupiah(unit)}/pcs)`;
      li.append(price);

      if (item.notes) {
        const note = document.createElement('em');
        note.className = 'ml-1 block text-slate-500';
        note.textContent = `Catatan: ${item.notes}`;
        li.append(note);
      }

      fragment.append(li);
    });
    itemList.replaceChildren(fragment);

    row.querySelector('[data-total]').textContent = `Total ${formatRupiah(order.total_amount)}`;
    row.querySelector('[data-dp]').textContent = `DP ${formatRupiah(order.dp_amount)}`;
    row.querySelector('[data-remaining]').textContent = `Sisa ${formatRupiah(order.remaining_amount)}`;

    const select = row.querySelector('[data-status]');
    select.id = `order-status-${order.id}`;
    select.replaceChildren(
      ...ORDER_STATUS_ORDER.map((value) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = ORDER_STATUS_LABELS[value] ?? value;
        return option;
      })
    );
    const current = ORDER_STATUS_LABELS[order.status] ? order.status : 'PENDING_DP';
    select.value = current;
    select.dataset.previous = current;
    select.setAttribute('aria-label', `Status pesanan ${order.order_code ?? ''}`);
    row.querySelector('[data-status-label]')?.setAttribute('for', select.id);

    const nextButton = row.querySelector('[data-next]');
    const next = nextStatus(current);
    nextButton.dataset.next = next;
    nextButton.disabled = !next;
    nextButton.textContent = next ? `${ORDER_STATUS_LABELS[next]} →` : 'Selesai';

    const contact = row.querySelector('[data-contact]');
    contact.href = buildContactLink(order, digits);
    contact.setAttribute('aria-label', `Hubungi ${order.customer_name ?? 'pembeli'} via WhatsApp`);
    return row;
  };

  const renderOrders = (orders, products) => {
    const list = Array.isArray(orders) ? orders : [];
    const productsById = new Map((products ?? []).map((product) => [product.id, product]));

    els.ordersEmpty?.classList.toggle('hidden', list.length > 0);
    if (els.ordersCount) {
      const pending = list.filter((order) => order.status === 'PENDING_DP').length;
      els.ordersCount.textContent = String(pending);
      els.ordersCount.classList.toggle('hidden', pending === 0);
      els.ordersCount.title = `${pending} pesanan menunggu DP`;
    }

    const fragment = document.createDocumentFragment();
    list.forEach((order) => fragment.append(buildOrderRow(order, productsById)));
    els.ordersBody.replaceChildren(fragment);
  };

  const showOrdersError = (message) => {
    const text = String(message ?? '').trim();
    els.ordersError?.classList.toggle('hidden', !text);
    if (els.ordersErrorText) els.ordersErrorText.textContent = text;
  };

  const setOrdersBusy = (busy) => {
    if (!els.ordersRefresh) return;
    els.ordersRefresh.disabled = busy;
    els.ordersRefresh.setAttribute('aria-busy', String(busy));
  };

  /** Wipes every rendered value; used on sign-out. */
  const clearSensitive = () => {
    editingKey = '';
    els.tripForm?.reset();
    els.productForm?.reset();
    els.productId.value = '';
    els.productFormTitle.textContent = 'Tambah Produk';
    els.productCancel.classList.add('hidden');
    els.productsBody.replaceChildren();
    els.ordersBody.replaceChildren();
    els.ordersCount?.classList.add('hidden');
    els.productsCount.textContent = '';
    els.productsEmpty?.classList.add('hidden');
    els.ordersEmpty?.classList.add('hidden');
    els.adminEmail.textContent = '';
    els.tripSavedAt.textContent = '';
    if (els.tripStatePill) {
      els.tripStatePill.textContent = '—';
      els.tripStatePill.className = 'badge bg-slate-100 text-slate-600';
    }
    showProductError('');
    showOrdersError('');
    showLoginError('');
    selectTab('trip');
  };

  /* ---------------------------------------------------------------- toasts */
  const showToast = (message, variant = 'success') => {
    if (!els.toastRegion || !message) return;

    const toast = document.createElement('div');
    toast.className =
      'pointer-events-auto flex w-full max-w-sm translate-y-2 items-start gap-2.5 rounded-2xl bg-white px-4 py-3 text-sm font-medium text-slate-700 opacity-0 shadow-lg ring-1 ring-slate-200 transition-all duration-300';

    const icon = document.createElement('i');
    icon.className = `fa-solid ${TOAST_STYLES[variant] ?? TOAST_STYLES.info} mt-0.5`;
    icon.setAttribute('aria-hidden', 'true');

    const text = document.createElement('p');
    text.className = 'flex-1 leading-snug';
    text.textContent = message;

    toast.append(icon, text);
    els.toastRegion.append(toast);

    while (els.toastRegion.children.length > 3) els.toastRegion.firstElementChild?.remove();

    window.requestAnimationFrame(() => toast.classList.remove('translate-y-2', 'opacity-0'));
    window.setTimeout(() => {
      toast.classList.add('translate-y-2', 'opacity-0');
      window.setTimeout(() => toast.remove(), 320);
    }, 3600);
  };

  return {
    els,
    cacheElements,
    showPhase,
    selectTab,
    setLoginBusy,
    showLoginError,
    setSessionEmail,
    fillTripForm,
    renderTripState,
    setTripBusy,
    setTripSavedAt,
    renderCategoryOptions,
    renderProductForm,
    showProductError,
    setProductBusy,
    renderProducts,
    renderOrders,
    showOrdersError,
    setOrdersBusy,
    clearSensitive,
    showToast,
    editingId,
  };
})();

/* ==========================================================================
 * 4. APP (auth flow + wiring)
 * ==========================================================================*/
const AdminApp = (() => {
  const { els } = AdminUI;
  const busy = { login: false, trip: false, product: false, orders: false };
  let authSubscription = null;

  /* ------------------------------------------------------------ rendering */
  const render = (state) => {
    if (!state.session) return; // signed out: nothing to paint
    AdminUI.setSessionEmail(state.session.user?.email);
    AdminUI.renderProducts(state.products);
    AdminUI.renderOrders(state.orders, state.products);

    const current = state.editingId ? state.products.find((product) => product.id === state.editingId) : null;
    if ((current?.id ?? '') !== AdminUI.editingId()) AdminUI.renderProductForm(current);
  };

  /* ---------------------------------------------------------------- errors */
  const mapAuthError = (error) => {
    const message = String(error?.message ?? '');
    if (/invalid login credentials/i.test(message)) return 'Email atau kata sandi salah.';
    if (/email not confirmed/i.test(message)) {
      return 'Email belum dikonfirmasi. Buka tautan konfirmasi di inbox, atau matikan "Confirm email" di Supabase.';
    }
    if (/rate limit|too many requests/i.test(message)) return 'Terlalu banyak percobaan masuk. Tunggu sebentar lalu coba lagi.';
    if (/failed to fetch|network/i.test(message)) return 'Tidak bisa menghubungi server. Periksa koneksi internet.';
    return message || 'Gagal masuk. Coba lagi.';
  };

  const mapDbError = (error) => {
    const code = String(error?.code ?? '');
    const message = String(error?.message ?? '');
    if (code === '23503') {
      return 'Produk sudah dipakai di pesanan sehingga tidak bisa dihapus. Set kuotanya ke 0 agar hilang dari toko.';
    }
    if (code === '23514') return 'Data ditolak aturan database. Periksa kembali isian (harga/kuota tidak boleh negatif).';
    if (code === '42501' || /permission denied|row-level security/i.test(message)) {
      return 'Akses ditolak. Sesi admin mungkin sudah berakhir — masuk ulang.';
    }
    if (code === 'PGRST116') return 'Data tidak ditemukan. Muat ulang halaman.';
    if (/failed to fetch|network/i.test(message)) return 'Koneksi ke server gagal. Periksa internet lalu coba lagi.';
    return message || 'Terjadi kesalahan. Coba lagi.';
  };

  /* ------------------------------------------------------------------ data */
  const loadAll = async () => {
    const [tripResult, productsResult, ordersResult] = await Promise.allSettled([
      AdminApi.fetchTrip(),
      AdminApi.fetchProducts(),
      AdminApi.fetchOrders(),
    ]);

    const trip = tripResult.status === 'fulfilled' ? tripResult.value : null;
    AdminStore.set({
      trip,
      products: productsResult.status === 'fulfilled' ? productsResult.value : [],
      orders: ordersResult.status === 'fulfilled' ? ordersResult.value : [],
      loaded: true,
    });

    if (trip) AdminUI.fillTripForm(trip);

    AdminUI.showOrdersError(
      ordersResult.status === 'rejected' ? mapDbError(ordersResult.reason) : ''
    );

    if (tripResult.status === 'rejected') {
      AdminUI.showToast(`Pengaturan trip gagal dimuat: ${mapDbError(tripResult.reason)}`, 'error');
    }
    if (productsResult.status === 'rejected') {
      AdminUI.showToast(`Produk gagal dimuat: ${mapDbError(productsResult.reason)}`, 'error');
    }
  };

  /* ------------------------------------------------------------------ auth */
  const enterDashboard = async (session) => {
    AdminStore.set({ session });
    AdminUI.showPhase('app');
    await loadAll();
  };

  const handleLogin = async (event) => {
    event.preventDefault();
    if (busy.login) return;

    const email = String(els.loginEmail.value ?? '').trim().toLowerCase();
    const password = String(els.loginPassword.value ?? '');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      AdminUI.showLoginError('Format email tidak valid.');
      els.loginEmail.focus();
      return;
    }
    if (password.length < 6) {
      AdminUI.showLoginError('Kata sandi minimal 6 karakter.');
      els.loginPassword.focus();
      return;
    }

    busy.login = true;
    AdminUI.showLoginError('');
    AdminUI.setLoginBusy(true);

    try {
      const session = await AdminApi.signIn(email, password);
      if (!session) throw new Error('Sesi tidak terbentuk. Coba lagi.');
      els.loginForm.reset();
      await enterDashboard(session);
      AdminUI.showToast('Berhasil masuk. Selamat bekerja!', 'success');
    } catch (error) {
      console.error('[Admin] sign-in failed', error);
      AdminUI.showLoginError(mapAuthError(error));
    } finally {
      busy.login = false;
      AdminUI.setLoginBusy(false);
    }
  };

  const handleLogout = async () => {
    try {
      await AdminApi.signOut();
    } catch (error) {
      console.error('[Admin] sign-out failed', error);
    }
    authSubscription?.unsubscribe?.();
    AdminStore.reset();
    AdminUI.clearSensitive();
    AdminUI.showPhase('auth');
    AdminUI.showToast('Kamu sudah keluar dari panel.', 'info');
  };

  const boot = async () => {
    AdminUI.cacheElements();
    AdminUI.renderCategoryOptions();
    AdminUI.selectTab('trip');
    bindEvents();
    AdminStore.subscribe(render);

    if (!isConfigReady()) {
      AdminUI.showPhase('config');
      return;
    }

    try {
      const session = await AdminApi.getSession();
      if (session) {
        await enterDashboard(session);
      } else {
        AdminUI.showPhase('auth');
      }
    } catch (error) {
      console.error('[Admin] session check failed', error);
      AdminUI.showPhase('auth');
      AdminUI.showLoginError('Gagal memeriksa sesi. Periksa koneksi lalu coba lagi.');
    }

    // Supabase warns against awaiting Supabase calls inside this callback,
    // so the handler only reacts to a lost session.
    authSubscription = AdminApi.onAuthChange((event, session) => {
      window.setTimeout(() => {
        if (event === 'SIGNED_OUT' || !session) {
          AdminStore.reset();
          AdminUI.clearSensitive();
          AdminUI.showPhase('auth');
        }
      }, 0);
    });
  };

  /* ------------------------------------------------------------------ trip */
  const readTripForm = () => {
    const city = String(els.tripCity.value ?? '').trim();
    const dpRaw = String(els.tripDp.value ?? '').trim();
    const closeRaw = String(els.tripClose.value ?? '').trim();
    const arrival = String(els.tripArrival.value ?? '').trim();
    const wa = String(els.tripWa.value ?? '').trim();

    if (city.length < 1 || city.length > 80) {
      return { ok: false, message: 'Kota tujuan wajib diisi, maksimal 80 karakter.', focus: els.tripCity };
    }
    const dp = Number(dpRaw);
    if (!dpRaw || !Number.isFinite(dp) || dp < 0 || dp > 100) {
      return { ok: false, message: 'DP harus angka bulat 0–100.', focus: els.tripDp };
    }
    if (closeRaw && Number.isNaN(new Date(closeRaw).getTime())) {
      return { ok: false, message: 'Tanggal tutup PO tidak valid.', focus: els.tripClose };
    }
    if (arrival.length > 120) {
      return { ok: false, message: 'Estimasi tiba maksimal 120 karakter.', focus: els.tripArrival };
    }
    if (wa && !isValidWaNumber(wa)) {
      return { ok: false, message: 'Nomor WhatsApp admin tidak valid (contoh: 08123456789).', focus: els.tripWa };
    }

    return {
      ok: true,
      patch: {
        destination_city: city,
        dp_percentage: Math.trunc(dp),
        close_date: closeRaw ? new Date(closeRaw).toISOString() : null,
        arrival_estimate: arrival || null,
        admin_whatsapp: wa ? normalizePhoneId(wa) : null,
        is_open: Boolean(els.tripOpen.checked),
      },
    };
  };

  const handleTripSubmit = async (event) => {
    event.preventDefault();
    if (busy.trip) return;

    const values = readTripForm();
    if (!values.ok) {
      AdminUI.showToast(values.message, 'error');
      values.focus?.focus();
      return;
    }

    busy.trip = true;
    AdminUI.setTripBusy(true);

    try {
      const saved = await AdminApi.saveTrip(values.patch);
      AdminStore.set({ trip: saved });
      AdminUI.fillTripForm(saved);
      AdminUI.setTripSavedAt(new Date());
      AdminUI.showToast('Pengaturan trip disimpan.', 'success');
    } catch (error) {
      console.error('[Admin] saveTrip failed', error);
      AdminUI.showToast(mapDbError(error), 'error');
    } finally {
      busy.trip = false;
      AdminUI.setTripBusy(false);
    }
  };

  /* -------------------------------------------------------------- products */
  const readProductForm = () => {
    const name = String(els.productName.value ?? '').trim();
    const category = String(els.productCategory.value ?? '');
    const store = String(els.productStore.value ?? '').trim();
    const imageUrl = String(els.productImage.value ?? '').trim();
    const priceRaw = String(els.productPrice.value ?? '').trim();
    const feeRaw = String(els.productFee.value ?? '').trim();
    const quotaRaw = String(els.productQuota.value ?? '').trim();
    const price = Number(priceRaw);
    const fee = Number(feeRaw);
    const quota = Number(quotaRaw);

    if (name.length < 1 || name.length > 120) {
      return { ok: false, message: 'Nama produk wajib diisi, maksimal 120 karakter.', focus: els.productName };
    }
    if (!CATEGORIES.some((item) => item.value === category && item.value !== 'all')) {
      return { ok: false, message: 'Pilih kategori produk.', focus: els.productCategory };
    }
    if (!priceRaw || !Number.isFinite(price) || price < 0) {
      return { ok: false, message: 'Harga barang wajib diisi, angka ≥ 0.', focus: els.productPrice };
    }
    if (!feeRaw || !Number.isFinite(fee) || fee < 0) {
      return { ok: false, message: 'Jastip fee wajib diisi, angka ≥ 0.', focus: els.productFee };
    }
    if (!quotaRaw || !Number.isFinite(quota) || quota < 0) {
      return { ok: false, message: 'Kuota wajib diisi, angka ≥ 0.', focus: els.productQuota };
    }
    if (imageUrl && !safeImageUrl(imageUrl)) {
      return { ok: false, message: 'URL gambar harus diawali http:// atau https://.', focus: els.productImage };
    }

    return {
      ok: true,
      row: {
        name,
        category,
        store_location: store || null,
        price: Math.trunc(price),
        jastip_fee: Math.trunc(fee),
        quota_available: Math.trunc(quota),
        image_url: imageUrl || null,
      },
    };
  };

  const handleProductSubmit = async (event) => {
    event.preventDefault();
    if (busy.product) return;

    const values = readProductForm();
    if (!values.ok) {
      AdminUI.showProductError(values.message);
      values.focus?.focus();
      return;
    }

    const editingId = String(els.productId.value ?? '');
    busy.product = true;
    AdminUI.showProductError('');
    AdminUI.setProductBusy(true);

    try {
      const saved = editingId
        ? await AdminApi.updateProduct(editingId, values.row)
        : await AdminApi.createProduct(values.row);

      const products = editingId
        ? AdminStore.get().products.map((product) => (product.id === saved.id ? saved : product))
        : [saved, ...AdminStore.get().products];

      AdminStore.set({ products, editingId: null });
      AdminUI.renderProductForm(null);
      AdminUI.showToast(editingId ? 'Produk diperbarui.' : 'Produk ditambahkan.', 'success');
      els.productName.focus();
    } catch (error) {
      console.error('[Admin] save product failed', error);
      AdminUI.showProductError(mapDbError(error));
    } finally {
      busy.product = false;
      AdminUI.setProductBusy(false);
    }
  };

  const startEditProduct = (productId) => {
    const product = AdminStore.get().products.find((item) => item.id === productId);
    if (!product) {
      AdminUI.showToast('Produk tidak ditemukan. Muat ulang halaman.', 'error');
      return;
    }
    AdminStore.set({ editingId: product.id });
    AdminUI.renderProductForm(product);
    AdminUI.selectTab('produk');
    els.productForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => els.productName.focus(), 220);
  };

  const cancelEditProduct = () => {
    AdminStore.set({ editingId: null });
    AdminUI.renderProductForm(null);
  };

  /* Two-step inline confirmation: a blocking window.confirm() cannot be styled,
     is easy to dismiss by accident, and freezes the page on mobile. */
  const resetDeleteButton = (button) => {
    delete button.dataset.armed;
    button.textContent = 'Hapus';
    button.classList.remove('!border-rose-600', '!bg-rose-600', '!text-white');
    button.setAttribute('aria-label', 'Hapus produk');
  };

  const armDeleteButton = (button) => {
    button.dataset.armed = '1';
    button.textContent = 'Yakin?';
    button.classList.add('!border-rose-600', '!bg-rose-600', '!text-white');
    button.setAttribute('aria-label', 'Klik lagi untuk menghapus permanen');
    window.setTimeout(() => {
      if (button.isConnected && button.dataset.armed === '1') resetDeleteButton(button);
    }, 4000);
  };

  const deleteProduct = async (productId, button) => {
    if (button?.disabled) return;
    if (button) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    }

    try {
      await AdminApi.deleteProduct(productId);
      AdminStore.set({
        products: AdminStore.get().products.filter((item) => item.id !== productId),
        editingId: AdminStore.get().editingId === productId ? null : AdminStore.get().editingId,
      });
      if (AdminUI.editingId() === productId) AdminUI.renderProductForm(null);
      AdminUI.showToast('Produk dihapus.', 'info');
    } catch (error) {
      console.error('[Admin] deleteProduct failed', error);
      AdminUI.showToast(mapDbError(error), 'error');
      if (button?.isConnected) {
        resetDeleteButton(button);
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    }
  };

  /* ---------------------------------------------------------------- orders */
  /** @returns {Promise<boolean>} true when the database accepted the change. */
  const applyStatus = async (orderId, status, control) => {
    if (!orderId || !status) return false;
    if (control) control.disabled = true;

    try {
      const updated = await AdminApi.updateOrderStatus(orderId, status);
      const nextStatusValue = updated?.status ?? status;
      AdminStore.set({
        orders: AdminStore.get().orders.map((order) =>
          order.id === orderId ? { ...order, status: nextStatusValue } : order
        ),
      });
      AdminUI.showToast(`Status diubah ke "${ORDER_STATUS_LABELS[nextStatusValue] ?? nextStatusValue}".`, 'success');
      return true;
    } catch (error) {
      console.error('[Admin] updateOrderStatus failed', error);
      AdminUI.showToast(mapDbError(error), 'error');
      if (control) control.disabled = false;
      return false;
    }
  };

  const handleOrdersRefresh = async () => {
    if (busy.orders) return;
    busy.orders = true;
    AdminUI.setOrdersBusy(true);
    AdminUI.showOrdersError('');

    try {
      const orders = await AdminApi.fetchOrders();
      AdminStore.set({ orders });
      AdminUI.showToast('Daftar pesanan dimuat ulang.', 'success');
    } catch (error) {
      console.error('[Admin] refresh orders failed', error);
      AdminUI.showOrdersError(mapDbError(error));
    } finally {
      busy.orders = false;
      AdminUI.setOrdersBusy(false);
    }
  };

  /* --------------------------------------------------------------- events */
  const bindEvents = () => {
    els.loginForm?.addEventListener('submit', handleLogin);
    els.loginForm?.addEventListener('input', () => AdminUI.showLoginError(''));

    els.loginTogglePassword?.addEventListener('click', () => {
      const input = els.loginPassword;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      els.loginTogglePassword.setAttribute('aria-pressed', String(!showing));
      els.loginTogglePassword.setAttribute('aria-label', showing ? 'Tampilkan kata sandi' : 'Sembunyikan kata sandi');
      els.loginTogglePassword.querySelector('i')?.classList.toggle('fa-eye', showing);
      els.loginTogglePassword.querySelector('i')?.classList.toggle('fa-eye-slash', !showing);
      input.focus();
    });

    els.logoutButton?.addEventListener('click', handleLogout);

    els.tabs.forEach((tab) => {
      tab.addEventListener('click', () => AdminUI.selectTab(tab.dataset.tab));
    });

    els.tripForm?.addEventListener('submit', handleTripSubmit);
    els.productForm?.addEventListener('submit', handleProductSubmit);
    els.productCancel?.addEventListener('click', cancelEditProduct);

    els.productsBody?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const productId = button.closest('[data-id]')?.dataset.id;
      if (!productId) return;
      if (button.dataset.action === 'edit') startEditProduct(productId);
      else if (button.dataset.action === 'delete') {
        if (button.dataset.armed === '1') deleteProduct(productId, button);
        else armDeleteButton(button);
      }
    });

    els.ordersBody?.addEventListener('change', (event) => {
      const select = event.target.closest('[data-status]');
      if (!select) return;
      const orderId = select.closest('[data-id]')?.dataset.id;
      const previous = select.dataset.previous ?? '';
      if (!orderId || select.value === previous) return;
      applyStatus(orderId, select.value, select).then((ok) => {
        if (!ok) select.value = previous; // the write was rejected: show the stored value again
      });
    });

    els.ordersBody?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-next]');
      if (!button || button.disabled) return;
      const orderId = button.closest('[data-id]')?.dataset.id;
      applyStatus(orderId, button.dataset.next, button);
    });

    els.ordersRefresh?.addEventListener('click', handleOrdersRefresh);
  };

  return { boot };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => AdminApp.boot(), { once: true });
} else {
  AdminApp.boot();
}
