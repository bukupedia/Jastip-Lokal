/* ============================================================================
 * js/app.js — storefront logic
 *
 * Module map (top to bottom):
 *   ApiService — the only code that talks to Supabase
 *   Store      — single source of truth + pub/sub + cart persistence
 *   UI         — DOM rendering; every dynamic value goes through textContent
 *   App        — wiring: events, load orchestration, user-facing actions
 *
 * Requires js/config.js (CONFIG, escapeHTML, formatRupiah, …).
 * ==========================================================================*/

'use strict';

/* ==========================================================================
 * 1. API SERVICE
 * ==========================================================================*/
const ApiService = (() => {
  let client = null;

  const getClient = () => {
    if (client) return client;

    if (typeof supabase === 'undefined' || typeof supabase.createClient !== 'function') {
      throw new Error('Pustaka Supabase gagal dimuat. Periksa koneksi internet lalu muat ulang halaman.');
    }
    if (!isConfigReady()) {
      throw new Error('Konfigurasi Supabase belum diisi. Lengkapi SUPABASE_URL dan SUPABASE_ANON_KEY di js/config.js.');
    }

    client = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      // The storefront is anonymous: no session to keep, nothing to refresh.
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    return client;
  };

  /** @returns {Promise<object|null>} the singleton trip row, or null if unset */
  const fetchTripSettings = async () => {
    const { data, error } = await getClient()
      .from('trip_settings')
      .select('id, destination_city, is_open, close_date, arrival_estimate, dp_percentage, admin_whatsapp')
      .eq('id', CONFIG.TRIP_SETTINGS_ID)
      .maybeSingle();

    if (error) {
      // PostgREST messages can leak schema details — log them, show a generic one.
      console.error('[ApiService] fetchTripSettings failed', error);
      throw new Error('Informasi trip gagal dimuat. Periksa koneksi internet lalu coba lagi.');
    }
    return data ?? null;
  };

  /** @returns {Promise<Array<object>>} */
  const fetchProducts = async () => {
    const { data, error } = await getClient()
      .from('products')
      .select('id, name, category, store_location, price, jastip_fee, quota_available, image_url, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[ApiService] fetchProducts failed', error);
      throw new Error('Katalog produk gagal dimuat. Periksa koneksi internet lalu coba lagi.');
    }
    return Array.isArray(data) ? data : [];
  };

  /** Carries the Postgres error code/hint so App can map it to Indonesian copy. */
  class OrderError extends Error {
    constructor(cause) {
      super(String(cause?.message ?? 'Pesanan gagal dibuat.'));
      this.name = 'OrderError';
      this.code = String(cause?.code ?? '');
      this.hint = String(cause?.hint ?? '');
    }
  }

  /**
   * Creates the order. The client only sends product ids, quantities and
   * notes — prices, fees, DP and quotas are all resolved inside the RPC.
   * @param {{customer_name: string, customer_wa: string, shipping_address: string,
   *          courier: string, items: Array<{product_id: string, quantity: number, notes: string}>}} payload
   * @returns {Promise<object>} RPC result (order_code, total_amount, dp_amount, …)
   */
  const submitOrder = async (payload) => {
    const { data, error } = await getClient().rpc('submit_jastip_order', { payload });

    if (error) {
      console.error('[ApiService] submit_jastip_order failed', error);
      throw new OrderError(error);
    }
    if (!data || typeof data !== 'object') {
      throw new OrderError({ message: 'Respons server tidak dikenali.' });
    }
    return data;
  };

  return { getClient, fetchTripSettings, fetchProducts, submitOrder, OrderError };
})();

/* ==========================================================================
 * 2. STORE
 * ==========================================================================*/
const Store = (() => {
  const listeners = new Set();
  const VALID_CATEGORIES = new Set(CATEGORIES.map((item) => item.value));

  /** Free text is stored as a plain string and rendered with textContent. */
  const cleanNotes = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

  const state = {
    status: 'idle', // idle | loading | ready | error
    errorMessage: '',
    trip: null,
    products: [],
    category: 'all',
    search: '',
    cart: readCart(),
  };

  function readCart() {
    try {
      const raw = window.localStorage.getItem(CONFIG.CART_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((line) => line && typeof line.id === 'string' && line.id.length > 0)
        .map((line) => ({
          id: line.id,
          qty: clampInt(line.qty, 1, CONFIG.MAX_QTY_PER_ITEM),
          notes: cleanNotes(line.notes),
        }));
    } catch (error) {
      return [];
    }
  }

  function writeCart() {
    try {
      window.localStorage.setItem(CONFIG.CART_STORAGE_KEY, JSON.stringify(state.cart));
    } catch (error) {
      /* private mode / quota exceeded — the cart simply won't survive reload */
    }
  }

  const notify = () => {
    listeners.forEach((listener) => {
      try {
        listener(state);
      } catch (error) {
        console.error('[Store] listener failed', error);
      }
    });
  };

  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const setState = (patch) => {
    Object.assign(state, patch);
    notify();
  };

  const getState = () => state;

  const setCategory = (category) => {
    if (!VALID_CATEGORIES.has(category) || category === state.category) return;
    setState({ category });
  };

  const setSearch = (search) => {
    const next = String(search ?? '');
    if (next === state.search) return;
    setState({ search: next });
  };

  const normalize = (value) => String(value ?? '').toLowerCase().trim();

  /** Search + category are applied client-side: the catalogue is small and
   *  this keeps one round-trip per page load. */
  const getVisibleProducts = () => {
    const term = normalize(state.search);
    return state.products.filter((product) => {
      if (state.category !== 'all' && product.category !== state.category) return false;
      if (!term) return true;
      return normalize(product.name).includes(term) || normalize(product.store_location).includes(term);
    });
  };

  const isTripOpen = () => {
    const trip = state.trip;
    if (!trip || trip.is_open !== true) return false;
    if (!trip.close_date) return true;
    const closesAt = new Date(trip.close_date).getTime();
    return Number.isFinite(closesAt) ? closesAt > Date.now() : true;
  };

  const findProduct = (productId) => state.products.find((product) => product.id === productId) ?? null;

  const quotaOf = (product) => Math.max(0, Math.trunc(Number(product?.quota_available) || 0));


  /** Max units a customer may put in the cart for one product. */
  const limitOf = (product) => Math.min(CONFIG.MAX_QTY_PER_ITEM, quotaOf(product));

  /** Drops cart lines whose product disappeared and clamps quantities to the
   *  current quota, so a stale localStorage snapshot can never oversell. */
  const pruneCart = () => {
    const next = state.cart
      .map((line) => {
        const product = findProduct(line.id);
        if (!product) return null;
        const limit = limitOf(product);
        if (limit < 1) return null;
        return { id: line.id, qty: clampInt(line.qty, 1, limit), notes: line.notes ?? '' };
      })
      .filter(Boolean);

    const changed =
      next.length !== state.cart.length ||
      next.some(
        (line, index) =>
          line.qty !== state.cart[index]?.qty ||
          line.id !== state.cart[index]?.id ||
          line.notes !== state.cart[index]?.notes
      );

    if (changed) {
      state.cart = next;
      writeCart();
      notify();
    }
  };

  /** @returns {{ok: boolean, message: string}} */
  const addToCart = (productId) => {
    const product = findProduct(productId);
    if (!product) return { ok: false, message: 'Produk tidak ditemukan.' };
    if (!isTripOpen()) return { ok: false, message: 'PO sedang ditutup, pesanan belum bisa dibuat.' };

    const limit = limitOf(product);
    if (limit < 1) return { ok: false, message: 'Stok produk ini sudah habis.' };

    const line = state.cart.find((item) => item.id === productId);
    if (line && line.qty >= limit) {
      return { ok: false, message: `Maksimal ${limit} pcs untuk produk ini.` };
    }

    if (line) line.qty += 1;
    else state.cart.push({ id: productId, qty: 1, notes: '' });

    writeCart();
    notify();
    return { ok: true, message: `${product.name} ditambahkan ke keranjang.` };
  };

  /** @returns {{ok: boolean, message: string}} */
  const changeQty = (productId, delta) => {
    const line = state.cart.find((item) => item.id === productId);
    if (!line) return { ok: false, message: 'Produk tidak ada di keranjang.' };

    const product = findProduct(productId);
    if (!product) {
      removeFromCart(productId);
      return { ok: false, message: 'Produk sudah tidak tersedia.' };
    }

    const limit = limitOf(product);
    const nextQty = line.qty + Math.trunc(Number(delta) || 0);

    if (nextQty < 1) {
      removeFromCart(productId);
      return { ok: true, message: `${product.name} dihapus dari keranjang.` };
    }
    if (nextQty > limit) {
      return { ok: false, message: `Maksimal ${limit} pcs untuk produk ini.` };
    }

    line.qty = nextQty;
    writeCart();
    notify();
    return { ok: true, message: '' };
  };

  /** Notes never affect totals, so this deliberately does NOT notify:
   *  re-rendering the list while the customer types would drop focus. */
  const setNote = (productId, notes) => {
    const line = state.cart.find((item) => item.id === productId);
    if (!line) return;
    const value = cleanNotes(notes);
    if (line.notes === value) return;
    line.notes = value;
    writeCart();
  };

  const removeFromCart = (productId) => {
    const before = state.cart.length;
    state.cart = state.cart.filter((line) => line.id !== productId);
    if (state.cart.length === before) return;
    writeCart();
    notify();
  };

  const clearCart = () => {
    if (state.cart.length === 0) return;
    state.cart = [];
    writeCart();
    notify();
  };

  /** Cart lines joined with live product data + integer-rupiah totals. */
  const getCartSummary = () => {
    const lines = state.cart
      .map((line) => {
        const product = findProduct(line.id);
        if (!product) return null;
        const unitPrice = Math.max(0, Math.trunc(Number(product.price) || 0));
        const unitFee = Math.max(0, Math.trunc(Number(product.jastip_fee) || 0));
        const unitTotal = unitPrice + unitFee;
        const qty = clampInt(line.qty, 1, Math.max(1, limitOf(product)));
        return {
          product,
          qty,
          notes: line.notes ?? '',
          limit: limitOf(product),
          unitPrice,
          unitFee,
          unitTotal,
          productTotal: unitPrice * qty,
          feeTotal: unitFee * qty,
          lineTotal: unitTotal * qty,
        };
      })
      .filter(Boolean);

    const productSubtotal = lines.reduce((sum, line) => sum + line.productTotal, 0);
    const totalFees = lines.reduce((sum, line) => sum + line.feeTotal, 0);
    const grandTotal = productSubtotal + totalFees;
    const dpPct = clampInt(state.trip?.dp_percentage ?? 50, 0, 100);
    // Same rounding as submit_jastip_order(): up to the nearest Rp 100.
    const dp = calcDp(grandTotal, dpPct);

    return {
      lines,
      productSubtotal,
      totalFees,
      grandTotal,
      subtotal: grandTotal,
      dpPct,
      dp,
      remaining: grandTotal - dp,
      count: lines.reduce((sum, line) => sum + line.qty, 0),
    };
  };

  return {
    subscribe,
    getState,
    setState,
    setCategory,
    setSearch,
    getVisibleProducts,
    isTripOpen,
    addToCart,
    changeQty,
    setNote,
    removeFromCart,
    clearCart,
    pruneCart,
    getCartSummary,
  };
})();

/* ==========================================================================
 * 3. UI (rendering only — no data fetching, no state mutation)
 * ==========================================================================*/
const UI = (() => {
  const els = {};
  let lastFocusedElement = null;

  const TOAST_STYLES = {
    success: 'fa-circle-check text-emerald-600',
    error: 'fa-circle-exclamation text-rose-600',
    info: 'fa-circle-info text-brand-600',
  };

  const cacheElements = () => {
    const ids = [
      'banner-skeleton', 'banner-content', 'trip-city', 'trip-status', 'trip-status-text',
      'trip-close', 'trip-countdown', 'trip-arrival', 'trip-dp', 'trip-note', 'trip-note-text',
      'result-count', 'search-input', 'search-clear', 'category-filters', 'product-grid',
      'empty-state', 'empty-state-title', 'empty-state-term', 'empty-state-desc',
      'empty-state-desc-empty', 'empty-reset', 'error-state', 'error-message', 'error-retry',
      'cart-button', 'cart-count', 'cart-backdrop', 'cart-drawer', 'cart-title-text',
      'cart-title-count', 'cart-step-cart', 'cart-step-checkout', 'cart-step-success',
      'cart-items', 'cart-empty', 'cart-footer', 'cart-product-subtotal', 'cart-fees',
      'cart-grand-total', 'cart-dp', 'cart-dp-pct', 'cart-remaining', 'cart-checkout',
      'cart-checkout-note', 'cart-clear',
      'co-total', 'co-dp', 'co-dp-pct', 'co-remaining', 'co-name', 'co-wa', 'co-address',
      'co-courier', 'checkout-error', 'checkout-error-text', 'checkout-submit', 'checkout-back',
      'success-code', 'success-total', 'success-dp', 'success-remaining', 'success-wa',
      'success-wa-note', 'success-close', 'toast-region',
    ];

    ids.forEach((id) => {
      const key = id.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      els[key] = document.getElementById(id);
    });

    els.tplProduct = document.getElementById('tpl-product');
    els.tplSkeleton = document.getElementById('tpl-skeleton');
    els.tplCartItem = document.getElementById('tpl-cart-item');
  };

  /* ---------------------------------------------------------------- banner */
  const renderBanner = ({ status, trip, tripOpen }) => {
    const isLoading = status === 'idle' || status === 'loading';
    els.bannerSkeleton?.classList.toggle('hidden', !isLoading);
    els.bannerContent?.classList.toggle('hidden', isLoading);
    if (isLoading || !els.bannerContent) return;

    const open = tripOpen;
    const city = String(trip?.destination_city ?? '').trim();

    els.tripCity.textContent = city || 'Kota tujuan belum diatur';
    els.tripStatus.dataset.state = trip ? (open ? 'open' : 'closed') : 'unknown';
    els.tripStatusText.textContent = trip ? (open ? 'PO Dibuka' : 'PO Ditutup') : 'Info belum tersedia';

    els.tripClose.textContent = trip?.close_date ? formatDateTimeId(trip.close_date) : 'Belum ditentukan';
    els.tripCountdown.textContent = trip?.close_date ? formatRelativeDays(trip.close_date) : '';
    els.tripArrival.textContent = String(trip?.arrival_estimate ?? '').trim() || 'Belum ditentukan';

    const dpPct = clampInt(trip?.dp_percentage ?? 50, 0, 100);
    els.tripDp.textContent = dpPct === 0 ? 'Tanpa uang muka' : `Hanya DP ${dpPct}%`;

    const showNote = !trip || !open;
    els.tripNote.classList.toggle('hidden', !showNote);
    els.tripNote.classList.toggle('flex', showNote);
    if (showNote) {
      els.tripNoteText.textContent = !trip
        ? 'Admin belum mengatur trip. Katalog tetap bisa dilihat, tetapi pemesanan belum dibuka.'
        : 'Pemesanan untuk trip ini sudah ditutup. Kamu masih bisa melihat katalog dan menunggu trip berikutnya.';
    }

    if (city) document.title = `Jastip ${city} — Jastip Lokal Indonesia`;
  };

  /* -------------------------------------------------------------- category */
  const renderCategories = () => {
    const container = els.categoryFilters;
    if (!container) return;

    const fragment = document.createDocumentFragment();
    CATEGORIES.forEach(({ value, label }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.dataset.category = value;
      button.setAttribute('aria-pressed', 'false');
      button.textContent = label;
      fragment.append(button);
    });
    container.replaceChildren(fragment);
  };

  const syncCategories = (activeCategory) => {
    els.categoryFilters?.querySelectorAll('[data-category]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.category === activeCategory));
    });
  };

  /* ---------------------------------------------------------------- search */
  const syncSearch = (value) => {
    if (!els.searchInput) return;
    if (els.searchInput.value !== value) els.searchInput.value = value;
    els.searchClear?.classList.toggle('hidden', value.length === 0);
  };

  /* --------------------------------------------------------------- product */
  const showImageFallback = (img, fallback) => {
    img.classList.add('hidden');
    fallback.classList.remove('hidden');
    fallback.classList.add('flex');
  };

  const buildProductCard = (product, tripOpen) => {
    const node = els.tplProduct.content.firstElementChild.cloneNode(true);
    const find = (selector) => node.querySelector(selector);

    const name = String(product?.name ?? '').trim() || 'Produk tanpa nama';
    const store = String(product?.store_location ?? '').trim();
    const quota = Math.max(0, Math.trunc(Number(product?.quota_available) || 0));
    const price = Math.max(0, Math.trunc(Number(product?.price) || 0));
    const fee = Math.max(0, Math.trunc(Number(product?.jastip_fee) || 0));

    find('[data-name]').textContent = name;
    find('[data-store]').textContent = store || 'Lokasi toko belum diisi';
    find('[data-price]').textContent = formatRupiah(price);
    find('[data-fee]').textContent = formatRupiah(fee);
    find('[data-category]').textContent = String(product?.category ?? 'Lainnya');

    const quotaBadge = find('[data-quota]');
    quotaBadge.textContent = quota > 0 ? `Sisa ${quota}` : 'Stok habis';
    quotaBadge.dataset.state = quota === 0 ? 'empty' : quota <= 3 ? 'low' : 'ok';

    const img = find('[data-img]');
    const fallback = find('[data-img-fallback]');
    const src = safeImageUrl(product?.image_url);
    if (src) {
      img.alt = `Foto ${name}`;
      img.addEventListener('error', () => showImageFallback(img, fallback), { once: true });
      img.src = src;
    } else {
      showImageFallback(img, fallback);
    }

    const button = find('[data-add]');
    const label = find('[data-add-label]');
    if (quota === 0) {
      button.disabled = true;
      label.textContent = 'Stok Habis';
      button.setAttribute('aria-label', `${name} sedang habis`);
    } else if (!tripOpen) {
      button.disabled = true;
      label.textContent = 'PO Ditutup';
      button.setAttribute('aria-label', `PO ditutup, ${name} belum bisa dipesan`);
    } else {
      button.setAttribute('aria-label', `Tambah ${name} ke keranjang`);
      button.addEventListener('click', () => App.addToCart(product.id));
    }

    return node;
  };

  const renderProducts = ({ status, products, totalCount, errorMessage, searchTerm, tripOpen }) => {
    const grid = els.productGrid;
    if (!grid) return;

    const isLoading = status === 'idle' || status === 'loading';
    const isError = status === 'error';
    const isEmpty = !isLoading && !isError && products.length === 0;

    grid.setAttribute('aria-busy', String(isLoading));
    els.errorState.classList.toggle('hidden', !isError);
    els.emptyState.classList.toggle('hidden', !isEmpty);

    if (isError) {
      els.errorMessage.textContent = errorMessage || 'Terjadi kesalahan saat menghubungi server.';
      grid.replaceChildren();
      grid.classList.add('hidden');
      els.resultCount.textContent = '';
      return;
    }

    if (isLoading) {
      grid.classList.remove('hidden');
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < CONFIG.SKELETON_COUNT; index += 1) {
        fragment.append(els.tplSkeleton.content.cloneNode(true));
      }
      grid.replaceChildren(fragment);
      els.resultCount.textContent = 'Memuat produk…';
      return;
    }

    if (isEmpty) {
      const catalogueEmpty = totalCount === 0;
      grid.replaceChildren();
      grid.classList.add('hidden');
      els.emptyStateTitle.textContent = catalogueEmpty ? 'Katalog masih kosong' : 'Produk tidak ditemukan';
      els.emptyStateDesc.classList.toggle('hidden', catalogueEmpty);
      els.emptyStateDescEmpty.classList.toggle('hidden', !catalogueEmpty);
      els.emptyStateTerm.textContent = String(searchTerm ?? '').trim() || 'filter ini';
      els.resultCount.textContent = catalogueEmpty ? 'Belum ada produk' : `0 dari ${totalCount} produk`;
      return;
    }

    grid.classList.remove('hidden');
    const fragment = document.createDocumentFragment();
    products.forEach((product) => fragment.append(buildProductCard(product, tripOpen)));
    grid.replaceChildren(fragment);
    els.resultCount.textContent = `Menampilkan ${products.length} dari ${totalCount} produk`;
  };

  /* ------------------------------------------------------------------ cart */
  const CART_STEPS = { cart: 'cart-step-cart', checkout: 'cart-step-checkout', success: 'cart-step-success' };
  const CART_TITLES = { cart: 'Keranjang', checkout: 'Data Pengiriman', success: 'Pesanan Dibuat' };

  /** Swaps the drawer between cart → checkout → success. */
  const setCartStep = (step) => {
    const target = CART_STEPS[step] ? step : 'cart';
    els.cartStepCart?.classList.toggle('hidden', target !== 'cart');
    els.cartStepCheckout?.classList.toggle('hidden', target !== 'checkout');
    els.cartStepSuccess?.classList.toggle('hidden', target !== 'success');
    if (els.cartTitleText) els.cartTitleText.textContent = CART_TITLES[target];
    if (els.cartTitleCount) els.cartTitleCount.classList.toggle('hidden', target !== 'cart');
    return target;
  };

  /** Filled once; the option list never changes at runtime. */
  const fillCouriers = () => {
    if (!els.coCourier || els.coCourier.options.length > 0) return;
    els.coCourier.replaceChildren(
      ...COURIERS.map((courier) => {
        const option = document.createElement('option');
        option.value = courier.value;
        option.textContent = courier.label;
        return option;
      })
    );
  };

  const buildCartLine = (line) => {
    const node = els.tplCartItem.content.firstElementChild.cloneNode(true);
    const find = (selector) => node.querySelector(selector);

    node.dataset.id = line.product.id;

    const name = String(line.product.name ?? '').trim() || 'Produk tanpa nama';
    find('[data-name]').textContent = name;
    find('[data-qty]').textContent = String(line.qty);
    find('[data-qty]').setAttribute('aria-label', `Jumlah ${name}`);
    find('[data-total]').textContent = formatRupiah(line.lineTotal);
    find('[data-meta]').textContent = `${formatRupiah(line.unitPrice)} + jastip ${formatRupiah(line.unitFee)}`;

    find('[data-limit]').textContent = line.qty >= line.limit ? 'Stok maks.' : `Sisa ${line.limit}`;
    find('[data-action="inc"]').disabled = line.qty >= line.limit;

    const notes = find('[data-notes]');
    notes.value = line.notes;
    notes.dataset.notesFor = line.product.id;
    notes.setAttribute('aria-label', `Catatan untuk ${name}`);

    const img = find('[data-img]');
    const fallback = find('[data-img-fallback]');
    const src = safeImageUrl(line.product.image_url);
    if (src) {
      img.alt = name;
      img.addEventListener('error', () => showImageFallback(img, fallback), { once: true });
      img.src = src;
    } else {
      showImageFallback(img, fallback);
    }

    return node;
  };

  const setCartBadge = (count) => {
    if (!els.cartCount) return;
    els.cartCount.textContent = count > 99 ? '99+' : String(count);
    els.cartCount.classList.toggle('hidden', count === 0);
    els.cartButton?.setAttribute('aria-label', count > 0 ? `Buka keranjang, ${count} item` : 'Buka keranjang');
  };

  const renderCart = (summary, trip, tripOpen) => {
    const hasItems = summary.lines.length > 0;

    els.cartItems?.classList.toggle('hidden', !hasItems);
    els.cartEmpty?.classList.toggle('hidden', hasItems);
    els.cartEmpty?.classList.toggle('flex', !hasItems);
    els.cartFooter?.classList.toggle('hidden', !hasItems);
    if (els.cartTitleCount) els.cartTitleCount.textContent = hasItems ? `${summary.count} item` : '';

    if (els.cartItems) {
      const fragment = document.createDocumentFragment();
      summary.lines.forEach((line) => fragment.append(buildCartLine(line)));
      els.cartItems.replaceChildren(fragment);
    }

    els.cartProductSubtotal.textContent = formatRupiah(summary.productSubtotal);
    els.cartFees.textContent = formatRupiah(summary.totalFees);
    els.cartGrandTotal.textContent = formatRupiah(summary.grandTotal);
    els.cartDpPct.textContent = String(summary.dpPct);
    els.cartDp.textContent = formatRupiah(summary.dp);
    els.cartRemaining.textContent = formatRupiah(summary.remaining);
    setCartBadge(summary.count);

    if (els.cartCheckout) els.cartCheckout.disabled = !hasItems || !tripOpen;
    if (els.cartCheckoutNote) {
      els.cartCheckoutNote.textContent = !hasItems
        ? ''
        : !tripOpen
          ? 'PO sudah ditutup. Pesanan baru tidak bisa dibuat.'
          : 'Harga, kuota, dan DP dihitung ulang oleh server saat pesanan dibuat.';
    }

    const onSuccess = Boolean(els.cartStepSuccess) && !els.cartStepSuccess.classList.contains('hidden');
    if (!hasItems && !onSuccess) setCartStep('cart');
  };

  const renderCheckoutSummary = (summary) => {
    if (els.coTotal) els.coTotal.textContent = formatRupiah(summary.grandTotal);
    if (els.coDpPct) els.coDpPct.textContent = String(summary.dpPct);
    if (els.coDp) els.coDp.textContent = formatRupiah(summary.dp);
    if (els.coRemaining) els.coRemaining.textContent = formatRupiah(summary.remaining);
  };

  const setCheckoutPending = (pending) => {
    const busy = Boolean(pending);
    if (els.checkoutSubmit) {
      els.checkoutSubmit.disabled = busy;
      els.checkoutSubmit.setAttribute('aria-busy', String(busy));
      els.checkoutSubmit.querySelector('[data-submit-spinner]')?.classList.toggle('hidden', !busy);
      const label = els.checkoutSubmit.querySelector('[data-submit-label]');
      if (label) label.textContent = busy ? 'Memproses pesanan…' : 'Buat Pesanan';
    }
    if (els.checkoutBack) els.checkoutBack.disabled = busy;
  };

  const showCheckoutError = (message) => {
    const text = String(message ?? '').trim();
    els.checkoutError?.classList.toggle('hidden', !text);
    if (els.checkoutErrorText) els.checkoutErrorText.textContent = text;
  };

  const clearCheckoutError = () => showCheckoutError('');

  const resetCheckoutForm = () => {
    els.cartStepCheckout?.reset();
    clearCheckoutError();
    setCheckoutPending(false);
  };

  const buildOrderConfirmationLink = (digits, order, trip) => {
    const city = String(trip?.destination_city ?? '').trim();
    const header = city
      ? `Halo Admin Jastip Lokal (${city}), saya sudah membuat pesanan dan ingin konfirmasi DP.`
      : 'Halo Admin Jastip Lokal, saya sudah membuat pesanan dan ingin konfirmasi DP.';

    const rows = order.items.map((item, index) => {
      const parts = [
        `${index + 1}. ${item.name}`,
        `   ${item.qty} x ${formatRupiah(item.unitTotal)} = ${formatRupiah(item.lineTotal)}`,
      ];
      if (item.store) parts.push(`   Toko: ${item.store}`);
      if (item.notes) parts.push(`   Catatan: ${item.notes}`);
      return parts.join('\n');
    });

    const message = [
      header,
      '',
      `Kode Pesanan: ${order.code}`,
      `Nama: ${order.customerName}`,
      `Kurir: ${order.courier}`,
      '',
      'Rincian pesanan:',
      ...rows,
      '',
      `Grand total: ${formatRupiah(order.total)}`,
      `DP ${order.dpPct}%: ${formatRupiah(order.dp)}`,
      `Sisa pelunasan: ${formatRupiah(order.remaining)}`,
      '',
      `Saya akan transfer DP sebesar ${formatRupiah(order.dp)} dan mengirim bukti transfernya. Terima kasih.`,
    ].join('\n');

    return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
  };

  const renderSuccess = (order, trip) => {
    if (els.successCode) els.successCode.textContent = order.code || '—';
    if (els.successTotal) els.successTotal.textContent = formatRupiah(order.total);
    if (els.successDp) els.successDp.textContent = formatRupiah(order.dp);
    if (els.successRemaining) els.successRemaining.textContent = formatRupiah(order.remaining);

    const digits = normalizePhoneId(trip?.admin_whatsapp);
    const canConfirm = digits.length >= 10;

    if (els.successWa) {
      if (canConfirm) {
        els.successWa.href = buildOrderConfirmationLink(digits, order, trip);
        els.successWa.classList.remove('pointer-events-none', 'opacity-50');
        els.successWa.removeAttribute('aria-disabled');
      } else {
        els.successWa.href = '#';
        els.successWa.classList.add('pointer-events-none', 'opacity-50');
        els.successWa.setAttribute('aria-disabled', 'true');
      }
    }
    if (els.successWaNote) {
      els.successWaNote.textContent = canConfirm
        ? 'Ringkasan pesanan otomatis terisi di WhatsApp.'
        : 'Nomor WhatsApp admin belum diatur. Hubungi admin lewat kanal lain.';
    }
  };

  /* --------------------------------------------------------------- toasts */
  const showToast = (message, variant = 'success') => {
    if (!els.toastRegion || !message) return;

    const iconClass = TOAST_STYLES[variant] ?? TOAST_STYLES.info;
    const toast = document.createElement('div');
    toast.className =
      'pointer-events-auto flex w-full max-w-sm translate-y-2 items-start gap-2.5 rounded-2xl bg-white px-4 py-3 text-sm font-medium text-slate-700 opacity-0 shadow-lg ring-1 ring-slate-200 transition-all duration-300';

    const icon = document.createElement('i');
    icon.className = `fa-solid ${iconClass} mt-0.5`;
    icon.setAttribute('aria-hidden', 'true');

    const text = document.createElement('p');
    text.className = 'flex-1 leading-snug';
    text.textContent = message; // never innerHTML

    toast.append(icon, text);
    els.toastRegion.append(toast);

    while (els.toastRegion.children.length > 3) {
      els.toastRegion.firstElementChild?.remove();
    }

    window.requestAnimationFrame(() => toast.classList.remove('translate-y-2', 'opacity-0'));
    window.setTimeout(() => {
      toast.classList.add('translate-y-2', 'opacity-0');
      window.setTimeout(() => toast.remove(), 320);
    }, 3200);
  };

  /* ---------------------------------------------------------------- drawer */
  const isCartOpen = () => Boolean(els.cartDrawer) && !els.cartDrawer.hasAttribute('inert');

  const openCart = () => {
    if (!els.cartDrawer || isCartOpen()) return;
    lastFocusedElement = document.activeElement;
    els.cartBackdrop.classList.remove('hidden');
    els.cartDrawer.classList.remove('translate-x-full');
    els.cartDrawer.removeAttribute('inert');
    els.cartButton?.setAttribute('aria-expanded', 'true');
    document.body.classList.add('overflow-hidden');
    window.setTimeout(() => els.cartDrawer.querySelector('[data-cart-close]')?.focus(), 50);
  };

  const closeCart = () => {
    if (!els.cartDrawer || !isCartOpen()) return;
    els.cartDrawer.classList.add('translate-x-full');
    els.cartDrawer.setAttribute('inert', '');
    els.cartBackdrop.classList.add('hidden');
    els.cartButton?.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('overflow-hidden');
    if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus();
  };

  const trapFocus = (event) => {
    if (event.key !== 'Tab' || !isCartOpen()) return;
    const focusables = els.cartDrawer.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return {
    els,
    cacheElements,
    renderBanner,
    renderCategories,
    syncCategories,
    syncSearch,
    renderProducts,
    renderCart,
    setCartStep,
    fillCouriers,
    renderCheckoutSummary,
    setCheckoutPending,
    showCheckoutError,
    clearCheckoutError,
    resetCheckoutForm,
    renderSuccess,
    showToast,
    openCart,
    closeCart,
    isCartOpen,
    trapFocus,
  };
})();

/* ==========================================================================
 * 4. APP (wiring)
 * ==========================================================================*/
const App = (() => {
  const render = (state) => {
    const visible = Store.getVisibleProducts();
    const tripOpen = Store.isTripOpen();
    UI.syncCategories(state.category);
    UI.renderBanner({ status: state.status, trip: state.trip, tripOpen });
    UI.renderProducts({
      status: state.status,
      products: visible,
      totalCount: state.products.length,
      errorMessage: state.errorMessage,
      searchTerm: state.search,
      tripOpen,
    });
    UI.renderCart(Store.getCartSummary(), state.trip, tripOpen);
  };

  const load = async () => {
    Store.setState({ status: 'loading', errorMessage: '' });

    const [tripResult, productsResult] = await Promise.allSettled([
      ApiService.fetchTripSettings(),
      ApiService.fetchProducts(),
    ]);

    const trip = tripResult.status === 'fulfilled' ? tripResult.value : null;
    const products = productsResult.status === 'fulfilled' ? productsResult.value : [];

    if (productsResult.status === 'rejected') {
      const message =
        productsResult.reason?.message ?? 'Katalog gagal dimuat. Periksa koneksi lalu coba lagi.';
      Store.setState({ status: 'error', errorMessage: message, trip });
      return;
    }

    Store.setState({ status: 'ready', trip, products, errorMessage: '' });
    Store.pruneCart();

    if (tripResult.status === 'rejected') {
      UI.showToast(
        tripResult.reason?.message ?? 'Informasi trip gagal dimuat, sebagian data mungkin tidak lengkap.',
        'error',
      );
    }
  };

  const addToCart = (productId) => {
    const result = Store.addToCart(productId);
    UI.showToast(result.message, result.ok ? 'success' : 'error');
  };

  const changeQty = (productId, delta) => {
    const result = Store.changeQty(productId, delta);
    if (!result.ok && result.message) UI.showToast(result.message, 'error');
  };

  const removeFromCart = (productId) => {
    Store.removeFromCart(productId);
    UI.showToast('Produk dihapus dari keranjang.', 'info');
  };

  /* ------------------------------------------------------------- checkout */
  let isSubmitting = false;

  const ORDER_ERROR_MESSAGES = {
    VALIDATION_ERROR: 'Data pesanan belum lengkap atau tidak valid. Periksa kembali isianmu.',
    TRIP_NOT_CONFIGURED: 'Trip belum dikonfigurasi admin. Coba lagi nanti.',
    TRIP_CLOSED: 'PO untuk trip ini sudah ditutup.',
    PRODUCT_NOT_FOUND: 'Salah satu produk sudah tidak tersedia. Keranjang sudah diperbarui.',
    OUT_OF_STOCK: 'Stok salah satu produk tidak lagi mencukupi. Kuota sudah diperbarui, sesuaikan jumlahnya.',
    ORDER_CODE_FAILED: 'Gagal membuat kode pesanan. Coba lagi.',
    INTERNAL_ERROR: 'Terjadi kesalahan di server. Coba lagi beberapa saat lagi.',
  };

  const currentStep = () => {
    if (UI.els.cartStepSuccess && !UI.els.cartStepSuccess.classList.contains('hidden')) return 'success';
    if (UI.els.cartStepCheckout && !UI.els.cartStepCheckout.classList.contains('hidden')) return 'checkout';
    return 'cart';
  };

  const mapOrderError = (error) => {
    const hint = String(error?.hint ?? '');
    if (ORDER_ERROR_MESSAGES[hint]) return ORDER_ERROR_MESSAGES[hint];
    if (error?.name === 'OrderError' && error.code === '42501') {
      return 'Pesanan ditolak server. Muat ulang halaman lalu coba lagi.';
    }
    if (error?.name === 'TypeError' || /fetch|network/i.test(String(error?.message ?? ''))) {
      return 'Koneksi ke server gagal. Periksa internetmu lalu coba lagi.';
    }
    return 'Pesanan gagal dibuat. Coba lagi beberapa saat lagi.';
  };

  /** Mirrors the RPC constraints so the customer gets feedback before the round trip. */
  const readCheckoutForm = () => {
    const name = String(UI.els.coName?.value ?? '').replace(/\s+/g, ' ').trim();
    const wa = String(UI.els.coWa?.value ?? '').trim();
    const address = String(UI.els.coAddress?.value ?? '').replace(/\s+/g, ' ').trim();
    const courier = String(UI.els.coCourier?.value ?? '').trim();

    if (name.length < 3 || name.length > 100) {
      return { ok: false, message: 'Nama lengkap harus 3-100 karakter.', focus: 'co-name' };
    }
    if (!isValidWaNumber(wa)) {
      return { ok: false, message: 'Nomor WhatsApp tidak valid. Gunakan format 08… atau 628….', focus: 'co-wa' };
    }
    if (address.length < 10 || address.length > 400) {
      return { ok: false, message: 'Alamat pengiriman harus 10-400 karakter.', focus: 'co-address' };
    }
    if (!COURIERS.some((option) => option.value === courier)) {
      return { ok: false, message: 'Pilih kurir pengiriman.', focus: 'co-courier' };
    }

    return { ok: true, values: { name, wa: normalizePhoneId(wa), address, courier } };
  };

  const refreshProducts = async () => {
    try {
      const products = await ApiService.fetchProducts();
      Store.setState({ products });
      Store.pruneCart();
    } catch (error) {
      console.error('[App] refreshProducts failed', error);
    }
  };

  const goToCheckout = () => {
    const summary = Store.getCartSummary();
    if (summary.lines.length === 0) return;
    if (!Store.isTripOpen()) {
      UI.showToast('PO sudah ditutup, pesanan baru tidak bisa dibuat.', 'error');
      return;
    }
    UI.renderCheckoutSummary(summary);
    UI.clearCheckoutError();
    UI.setCartStep('checkout');
    window.setTimeout(() => UI.els.coName?.focus(), 60);
  };

  const handleCheckoutSubmit = async (event) => {
    event.preventDefault();
    if (isSubmitting) return; // guards double submits

    const summary = Store.getCartSummary();
    if (summary.lines.length === 0) {
      UI.showCheckoutError('Keranjangmu masih kosong.');
      return;
    }
    if (!Store.isTripOpen()) {
      UI.showCheckoutError('PO untuk trip ini sudah ditutup.');
      return;
    }

    const form = readCheckoutForm();
    if (!form.ok) {
      UI.showCheckoutError(form.message);
      document.getElementById(form.focus)?.focus();
      return;
    }

    isSubmitting = true;
    UI.clearCheckoutError();
    UI.setCheckoutPending(true);

    // Snapshot the lines: the cart is cleared as soon as the RPC succeeds.
    const items = summary.lines.map((line) => ({
      name: String(line.product.name ?? '').trim() || 'Produk',
      store: String(line.product.store_location ?? '').trim(),
      qty: line.qty,
      notes: line.notes,
      unitTotal: line.unitTotal,
      lineTotal: line.lineTotal,
    }));

    try {
      const result = await ApiService.submitOrder({
        customer_name: form.values.name,
        customer_wa: form.values.wa,
        shipping_address: form.values.address,
        courier: form.values.courier,
        items: summary.lines.map((line) => ({
          product_id: line.product.id,
          quantity: line.qty,
          notes: line.notes,
        })),
      });

      const order = {
        code: String(result?.order_code ?? '').trim(),
        total: Math.max(0, Math.trunc(Number(result?.total_amount) || 0)),
        dp: Math.max(0, Math.trunc(Number(result?.dp_amount) || 0)),
        remaining: Math.max(0, Math.trunc(Number(result?.remaining_amount) || 0)),
        dpPct: clampInt(result?.dp_percentage ?? summary.dpPct, 0, 100),
        customerName: String(result?.customer_name ?? form.values.name).trim(),
        courier: form.values.courier,
        items,
      };

      UI.setCartStep('success'); // before clearCart, so the empty-cart guard leaves us here
      Store.clearCart();
      UI.renderSuccess(order, Store.getState().trip);
      UI.showToast(`Pesanan ${order.code || ''} berhasil dibuat.`.trim(), 'success');
      window.setTimeout(() => UI.els.successWa?.focus(), 60);

      await refreshProducts();
    } catch (error) {
      UI.showCheckoutError(mapOrderError(error));
      if (['OUT_OF_STOCK', 'PRODUCT_NOT_FOUND', 'TRIP_CLOSED'].includes(String(error?.hint ?? ''))) {
        await refreshProducts();
      }
    } finally {
      isSubmitting = false;
      UI.setCheckoutPending(false);
    }
  };

  const resetFilters = () => {
    Store.setCategory('all');
    Store.setSearch('');
    UI.syncSearch('');
    UI.els.searchInput?.focus();
  };

  const bindEvents = () => {
    const { els } = UI;

    // category chips (event delegation — chips are rendered dynamically)
    els.categoryFilters?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-category]');
      if (button) Store.setCategory(button.dataset.category);
    });

    // search
    const applySearch = debounce((value) => Store.setSearch(value), CONFIG.SEARCH_DEBOUNCE_MS);
    els.searchInput?.addEventListener('input', (event) => {
      const value = event.target.value;
      els.searchClear?.classList.toggle('hidden', value.length === 0);
      applySearch(value);
    });
    els.searchInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && els.searchInput.value) {
        event.preventDefault();
        els.searchInput.value = '';
        els.searchClear?.classList.add('hidden');
        Store.setSearch('');
      }
    });
    els.searchClear?.addEventListener('click', () => {
      els.searchInput.value = '';
      els.searchClear.classList.add('hidden');
      Store.setSearch('');
      els.searchInput.focus();
    });

    // states
    els.emptyReset?.addEventListener('click', resetFilters);
    els.errorRetry?.addEventListener('click', () => {
      load();
    });

    // cart drawer
    els.cartButton?.addEventListener('click', () => {
      if (currentStep() === 'success') {
        UI.resetCheckoutForm();
        UI.setCartStep('cart');
      }
      UI.openCart();
    });
    document.querySelectorAll('[data-cart-close]').forEach((node) => {
      node.addEventListener('click', () => UI.closeCart());
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') UI.closeCart();
      UI.trapFocus(event);
    });

    els.cartItems?.addEventListener('click', (event) => {
      const actionButton = event.target.closest('[data-action]');
      if (!actionButton) return;
      const line = actionButton.closest('[data-id]');
      const productId = line?.dataset?.id;
      if (!productId) return;

      const action = actionButton.dataset.action;
      if (action === 'inc') changeQty(productId, 1);
      else if (action === 'dec') changeQty(productId, -1);
      else if (action === 'remove') removeFromCart(productId);
    });

    els.cartClear?.addEventListener('click', () => {
      Store.clearCart();
      UI.showToast('Keranjang dikosongkan.', 'info');
    });

    // per-item notes — Store.setNote is silent, so the field keeps focus
    els.cartItems?.addEventListener('input', (event) => {
      const input = event.target.closest('[data-notes]');
      if (!input?.dataset.notesFor) return;
      Store.setNote(input.dataset.notesFor, input.value);
    });

    // checkout flow
    els.cartStepCheckout?.addEventListener('input', () => UI.clearCheckoutError());
    els.cartCheckout?.addEventListener('click', goToCheckout);
    els.cartStepCheckout?.addEventListener('submit', handleCheckoutSubmit);
    els.checkoutBack?.addEventListener('click', () => {
      UI.clearCheckoutError();
      UI.setCartStep('cart');
      window.setTimeout(() => UI.els.cartCheckout?.focus(), 60);
    });
    els.successClose?.addEventListener('click', () => UI.closeCart());
  };

  const init = () => {
    UI.cacheElements();
    UI.renderCategories();
    UI.syncSearch('');
    UI.fillCouriers();
    UI.setCartStep('cart');
    bindEvents();
    Store.subscribe(render);
    load();
  };

  return { init, addToCart, load };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init(), { once: true });
} else {
  App.init();
}
