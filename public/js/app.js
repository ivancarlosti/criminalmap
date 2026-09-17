/* global vis, I18n, Theme */
(function (global) {
  'use strict';

  // Post-it color palette (background + border pairs) used for nodes.
  // Colors are assigned deterministically by hashing the node label so the
  // same entity always gets the same color across renders.
  const POST_IT_COLORS = [
    { background: '#FFF59D', border: '#C9B458' },
    { background: '#FFCC80', border: '#C9933D' },
    { background: '#F48FB1', border: '#B85C7E' },
    { background: '#90CAF9', border: '#4E8BB5' },
    { background: '#A5D6A7', border: '#5E8A61' },
    { background: '#CE93D8', border: '#8E5FA0' },
    { background: '#FFAB91', border: '#B86A50' },
    { background: '#80CBC4', border: '#468A83' },
  ];

  // Edge and label colors per theme.
  const THEME_STYLES = {
    dark: {
      edgeColor: '#e6b84c',
      edgeHighlight: '#ffe082',
      edgeHover: '#fff59d',
      edgeLabel: '#d8c9a3',
      edgeLabelStroke: '#0d0d0d',
      nodeLabel: '#211d19',
    },
    light: {
      edgeColor: '#a8761f',
      edgeHighlight: '#c9933d',
      edgeHover: '#b8862a',
      edgeLabel: '#4a3f2a',
      edgeLabelStroke: '#f7f2e7',
      nodeLabel: '#2b2419',
    },
  };

  // Physics profiles. The compact one is used on narrow (phone) viewports: the
  // same number of nodes then occupies a much smaller area, so the automatic
  // fit zooms in less and the labels stay readable.
  const PHYSICS_PROFILES = {
    wide: {
      gravitationalConstant: -6000,
      centralGravity: 0.25,
      springLength: 150,
      springConstant: 0.05,
      damping: 0.3,
      avoidOverlap: 0.3,
    },
    compact: {
      gravitationalConstant: -3200,
      centralGravity: 0.35,
      springLength: 90,
      springConstant: 0.06,
      damping: 0.35,
      avoidOverlap: 0.4,
    },
  };

  const COMPACT_VIEWPORT_QUERY = '(max-width: 900px)';
  const COARSE_POINTER_QUERY = '(pointer: coarse)';
  const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
  const STABILIZATION_ITERATIONS = 200;

  // How long the solver keeps relaxing after a drag before it is frozen again.
  const SETTLE_DELAY_MS = 600;

  // Frames used to wait for a measurable canvas before reporting a problem.
  const SIZE_RETRY_LIMIT = 12;

  // Explicit height (share of the visible viewport) used on phones, both in CSS
  // and as a runtime fallback for browsers that resolve the flex height to 0.
  const COMPACT_HEIGHT_RATIO = 0.58;
  const COMPACT_HEIGHT_MIN = 320;
  const COMPACT_HEIGHT_MAX = 620;

  const VIS_LIBRARY_TIMEOUT_MS = 8000;

  const state = {
    network: null,
    graph: { nodes: [], edges: [] },
    modalType: null, // 'edge' | 'node' | null
    modalData: null,
    networkMessage: null, // i18n key of the message currently shown
    networkMessageVars: null, // interpolation values of that message
    settleTimer: null, // pending "let the physics relax, then freeze" timer
    resizeTimer: null, // debounce timer for viewport resizes
    sizeAttempts: 0, // retries spent waiting for a measurable canvas
    forcedHeight: false, // true once the inline phone height was applied
  };

  const elements = {
    network: document.getElementById('network'),
    networkMessage: document.getElementById('network-message'),
    textarea: document.getElementById('relation-input'),
    parseButton: document.getElementById('parse-button'),
    clearButton: document.getElementById('clear-button'),
    langSelect: document.getElementById('lang-select'),
    modal: document.getElementById('edge-modal'),
    modalTitle: document.getElementById('modal-title'),
    modalBody: document.getElementById('modal-body'),
    modalClose: document.getElementById('modal-close'),
    copyMapUrl: document.getElementById('copy-map-url'),
    copyRelations: document.getElementById('copy-relations'),
  };

  /** @returns {string} the active theme name. */
  function currentTheme() {
    if (global.Theme && typeof global.Theme.current === 'function') {
      return global.Theme.current();
    }

    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  /** @returns {Object} the color set for the active theme. */
  function themeStyle() {
    return THEME_STYLES[currentTheme()] || THEME_STYLES.dark;
  }

  // Simple deterministic 32-bit string hash (djb2 variant).
  function hashString(value) {
    let hash = 5381;
    const text = String(value);
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function colorForLabel(label) {
    return POST_IT_COLORS[hashString(label) % POST_IT_COLORS.length];
  }

  function buildNodeDataSet(nodes) {
    const style = themeStyle();

    return new vis.DataSet(nodes.map((node) => {
      const palette = colorForLabel(node.label);
      const type = node.type || 'person';

      return {
        id: node.id,
        label: node.label,
        title: `${node.label} (${type})`,
        shape: 'box',
        shapeProperties: { borderRadius: 8 },
        color: {
          background: palette.background,
          border: palette.border,
          highlight: { background: palette.background, border: '#ffffff' },
          hover: { background: palette.background, border: '#ffffff' },
        },
        font: { color: style.nodeLabel, face: 'monospace', size: 14 },
        borderWidth: 2,
        borderWidthSelected: 3,
        shadow: { enabled: true, color: 'rgba(0, 0, 0, 0.45)', size: 8, x: 2, y: 3 },
        margin: 12,
      };
    }));
  }

  function buildEdgeDataSet(edges, nodes) {
    const labelById = new Map(nodes.map((node) => [node.id, node.label]));
    const style = themeStyle();

    return new vis.DataSet(edges.map((edge) => {
      const fromLabel = labelById.get(edge.from) || String(edge.from);
      const toLabel = labelById.get(edge.to) || String(edge.to);

      return {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        title: `${fromLabel} → ${toLabel}: ${edge.topic_description}`,
        arrows: { to: { enabled: true, scaleFactor: 0.7 } },
        smooth: { enabled: true, type: 'continuous', roundness: 0.35 },
        color: {
          color: style.edgeColor,
          highlight: style.edgeHighlight,
          hover: style.edgeHover,
          opacity: 0.9,
        },
        width: 2,
        selectionWidth: 3,
        font: {
          color: style.edgeLabel,
          face: 'monospace',
          size: 11,
          align: 'top',
          strokeWidth: 2,
          strokeColor: style.edgeLabelStroke,
        },
      };
    }));
  }

  /**
   * @param {string} query a CSS media query
   * @returns {boolean} true when the query matches the current viewport.
   */
  function matchesMedia(query) {
    return typeof global.matchMedia === 'function' ? global.matchMedia(query).matches : false;
  }

  /** @returns {boolean} true on phone/tablet sized viewports. */
  function isCompactViewport() {
    return matchesMedia(COMPACT_VIEWPORT_QUERY);
  }

  /** @returns {boolean} true on touch devices, where hovering does not exist. */
  function isCoarsePointer() {
    return matchesMedia(COARSE_POINTER_QUERY);
  }

  /**
   * @param {boolean} animated
   * @returns {Object} options for network.fit(), honouring reduced motion.
   */
  function fitOptions(animated) {
    if (!animated || matchesMedia(REDUCED_MOTION_QUERY)) {
      return { animation: false };
    }

    return { animation: { duration: 600, easingFunction: 'easeInOutQuad' } };
  }

  /** @returns {boolean} true when the page was opened with ?debug=1. */
  function debugEnabled() {
    return /(?:^|[?&])debug=1(?:&|$)/.test(String((global.location && global.location.search) || ''));
  }

  function buildOptions() {
    const compact = isCompactViewport();

    return {
      autoResize: true,
      physics: {
        enabled: true,
        solver: 'barnesHut',
        barnesHut: compact ? PHYSICS_PROFILES.compact : PHYSICS_PROFILES.wide,
        // Damped solver settings: the layout slows down and stops on its own
        // instead of leaving a permanent micro-movement behind.
        minVelocity: 1,
        maxVelocity: 30,
        timestep: 0.35,
        adaptiveTimestep: true,
        stabilization: {
          enabled: true,
          iterations: STABILIZATION_ITERATIONS,
          updateInterval: 20,
          // The initial fit is done explicitly, so later settles never re-frame
          // the view the user has panned or zoomed.
          fit: false,
        },
      },
      interaction: {
        hover: !isCoarsePointer(),
        tooltipDelay: 150,
        dragNodes: true,
        dragView: true,
        zoomView: true,
        keyboard: { enabled: true, bindToWindow: false },
      },
      nodes: { chosen: true, shape: 'box' },
      edges: { chosen: true },
      layout: { improvedLayout: true, randomSeed: 7 },
    };
  }

  /**
   * Physics runs only while the graph is settling; afterwards the solver is
   * frozen so nothing keeps drifting or wobbling after a pinch, pan or drag.
   *
   * vis emits the stabilization events again from setOptions()/stopSimulation(),
   * so this function is intentionally idempotent.
   *
   * @param {Object} network
   */
  function freezePhysics(network) {
    // Freezing always cancels a pending "relax for a moment" timer, so the
    // solver can never come back to life on its own after it was stopped.
    if (state.settleTimer) {
      global.clearTimeout(state.settleTimer);
      state.settleTimer = null;
    }

    const physics = network.physics;

    if (!physics || !physics.options || physics.options.enabled === false) {
      return;
    }

    network.setOptions({ physics: { enabled: false } });

    if (typeof network.stopSimulation === 'function') {
      // false: do not re-emit the stabilization events.
      network.stopSimulation(false);
    }
  }

  /**
   * Let the solver relax for a moment (smooth, damped movement) and freeze it
   * again. Used when the graph content changes (initial load, Process), where
   * the new nodes still have to find a place. Releasing a dragged node never
   * goes through this path: the graph must not rearrange on its own.
   *
   * @param {Object} network
   */
  function settlePhysics(network) {
    if (state.settleTimer) {
      global.clearTimeout(state.settleTimer);
    }

    network.setOptions({ physics: { enabled: true } });

    if (typeof network.startSimulation === 'function') {
      network.startSimulation();
    }

    state.settleTimer = global.setTimeout(() => {
      state.settleTimer = null;
      freezePhysics(network);
    }, SETTLE_DELAY_MS);
  }

  /**
   * Wire the stabilization lifecycle of a freshly created network.
   *
   * @param {Object} network
   */
  function bindPhysicsEvents(network) {
    network.once('stabilizationIterationsDone', () => {
      const box = networkBox();

      // Only frame the graph when the canvas already has a real size.
      if (box.width > 0 && box.height > 0) {
        network.fit(fitOptions(false));
      }

      freezePhysics(network);
    });

    network.on('stabilizationIterationsDone', () => freezePhysics(network));

    network.on('dragStart', () => {
      if (state.settleTimer) {
        global.clearTimeout(state.settleTimer);
        state.settleTimer = null;
      }

      // While a node is dragged its neighbours follow, then everything settles.
      network.setOptions({ physics: { enabled: true } });
    });

    // Releasing a node does NOT rearrange the graph: the solver is frozen right
    // away so every node keeps the position it had when the drag ended. The
    // layout only moves while the user is actually dragging a node.
    network.on('dragEnd', () => freezePhysics(network));
  }

  /**
   * Show an i18n message on top of the network canvas.
   *
   * @param {string} key
   * @param {Object} [vars] interpolation values for the message
   */
  function setNetworkMessage(key, vars) {
    state.networkMessage = key;
    state.networkMessageVars = vars || null;

    if (elements.networkMessage) {
      elements.networkMessage.textContent = I18n.translate(key, state.networkMessageVars);
      elements.networkMessage.hidden = false;
    }
  }

  function clearNetworkMessage() {
    state.networkMessage = null;
    state.networkMessageVars = null;

    if (elements.networkMessage) {
      elements.networkMessage.textContent = '';
      elements.networkMessage.hidden = true;
      elements.networkMessage.classList.remove('network-message-debug');
    }
  }

  /**
   * Report a problem that prevents the graph from being drawn: it is logged for
   * developers and shown on the page, because on a phone the console is usually
   * out of reach.
   *
   * @param {string} key
   * @param {Object} [vars]
   */
  function reportGraphProblem(key, vars) {
    console.error(`[criminalmap] graph: ${key}`, vars || {});
    setNetworkMessage(key, vars);
  }

  /** @returns {{width: number, height: number}} the measured graph container. */
  function networkBox() {
    if (!elements.network) {
      return { width: 0, height: 0 };
    }

    return {
      width: elements.network.clientWidth || 0,
      height: elements.network.clientHeight || 0,
    };
  }

  /**
   * On phone sized viewports pin the height of the graph area in pixels.
   *
   * Some mobile browsers resolve a flex based / viewport based height to zero
   * until the page has been laid out (or when the address bar moves), which
   * leaves vis with a 0×0 canvas and an apparently empty graph area.
   */
  function applyCompactHeight() {
    if (!elements.network) {
      return;
    }

    if (!isCompactViewport()) {
      if (state.forcedHeight) {
        elements.network.style.height = '';
        state.forcedHeight = false;
      }

      return;
    }

    const height = Math.round(Math.min(
      Math.max(global.innerHeight * COMPACT_HEIGHT_RATIO, COMPACT_HEIGHT_MIN),
      COMPACT_HEIGHT_MAX
    ));

    elements.network.style.height = `${height}px`;
    state.forcedHeight = true;
  }

  /**
   * Run a callback on the next frame. rAF is throttled (or paused) on mobile
   * browsers and inside background tabs, so a timer guarantees the retries below
   * keep progressing even when the callback would never be scheduled.
   *
   * @param {Function} callback
   */
  function nextFrame(callback) {
    let called = false;

    const run = () => {
      if (called) {
        return;
      }

      called = true;
      callback();
    };

    global.setTimeout(run, 32);

    if (typeof global.requestAnimationFrame === 'function') {
      global.requestAnimationFrame(run);
    }
  }

  /**
   * Make sure vis knows about a real canvas size and, when requested, frame the
   * graph. Sizes are re-measured for a few frames because the first paint of a
   * mobile browser may happen before the final layout.
   *
   * @param {Object} network
   * @param {{fit?: boolean, animated?: boolean, report?: boolean}} [options]
   */
  function ensureNetworkSize(network, options = {}) {
    if (!elements.network || !network) {
      return;
    }

    const box = networkBox();

    if (box.width === 0 || box.height === 0) {
      if (state.sizeAttempts < SIZE_RETRY_LIMIT) {
        state.sizeAttempts += 1;
        nextFrame(() => ensureNetworkSize(network, options));
        return;
      }

      if (options.report === true) {
        reportGraphProblem('networkSizeError', { width: box.width, height: box.height });
      }

      return;
    }

    state.sizeAttempts = 0;
    network.setSize(`${box.width}px`, `${box.height}px`);
    network.redraw();

    // A transient "no size" message must not outlive the problem.
    if (state.networkMessage === 'networkSizeError') {
      clearNetworkMessage();
    }

    if (options.fit === true) {
      network.fit(fitOptions(options.animated === true));
    }

    if (debugEnabled()) {
      showDebugInfo(network);
    }
  }

  /**
   * ?debug=1 -> print the measurements that matter on a phone screen: whether
   * the library loaded, the size of the container and the graph statistics.
   *
   * @param {Object} network
   */
  function showDebugInfo(network) {
    const box = networkBox();
    const scale = typeof network.getScale === 'function' ? network.getScale() : 0;

    if (elements.networkMessage) {
      elements.networkMessage.classList.add('network-message-debug');
    }

    setNetworkMessage('networkDebugInfo', {
      library: global.vis ? 'vis-network' : 'ausente/missing',
      width: box.width,
      height: box.height,
      nodes: state.graph.nodes.length,
      edges: state.graph.edges.length,
      scale: Math.round(scale * 100) / 100,
    });
  }

  /**
   * Render a graph payload (working graph or saved map).
   *
   * @param {{nodes: Array, edges: Array}} graph
   */
  function renderGraph(graph) {
    state.graph = graph || { nodes: [], edges: [] };
    state.sizeAttempts = 0;

    const nodes = buildNodeDataSet(state.graph.nodes);
    const edges = buildEdgeDataSet(state.graph.edges, state.graph.nodes);

    if (state.graph.nodes.length === 0) {
      setNetworkMessage('networkEmpty');
    } else {
      clearNetworkMessage();
    }

    if (state.network) {
      state.network.setData({ nodes, edges });
      // New nodes must reach a sensible place, then the solver is frozen again.
      settlePhysics(state.network);
      // ensureNetworkSize() re-frames the graph once the canvas has a real size.
      ensureNetworkSize(state.network, { fit: true, animated: true });
      return;
    }

    applyCompactHeight();

    state.network = new vis.Network(elements.network, { nodes, edges }, buildOptions());
    state.network.on('click', handleNetworkClick);
    bindPhysicsEvents(state.network);
    ensureNetworkSize(state.network, { fit: true, animated: false, report: true });
  }

  function labelMap() {
    return new Map(state.graph.nodes.map((node) => [node.id, node.label]));
  }

  function handleNetworkClick(params) {
    if (params.edges && params.edges.length > 0) {
      const edge = state.graph.edges.find((item) => item.id === params.edges[0]);
      if (edge) {
        openEdgeModal(edge);
      }
      return;
    }

    if (params.nodes && params.nodes.length > 0) {
      const node = state.graph.nodes.find((item) => item.id === params.nodes[0]);
      if (node) {
        openNodeModal(node);
      }
    }
  }


  function openEdgeModal(edge) {
    state.modalType = 'edge';
    state.modalData = edge;
    renderModal();
    showModal();
  }

  function openNodeModal(node) {
    state.modalType = 'node';
    state.modalData = node;
    renderModal();
    showModal();
  }

  function renderModal() {
    if (state.modalType === 'edge') {
      renderEdgeModal(state.modalData);
    } else if (state.modalType === 'node') {
      renderNodeModal(state.modalData);
    }
  }

  function renderEdgeModal(edge) {
    const labels = labelMap();
    const fromLabel = labels.get(edge.from) || String(edge.from);
    const toLabel = labels.get(edge.to) || String(edge.to);

    elements.modalTitle.textContent = I18n.translate('modalTitle');

    const direction = document.createElement('p');
    direction.className = 'modal-direction';
    direction.textContent = I18n.translate('edgeDirectionHint', { from: fromLabel, to: toLabel });

    const topicWrap = document.createElement('div');
    topicWrap.className = 'modal-section';
    const topicLabel = document.createElement('h3');
    topicLabel.className = 'modal-section-title';
    topicLabel.textContent = I18n.translate('modalTopicLabel');
    const topicValue = document.createElement('p');
    topicValue.className = 'modal-topic';
    topicValue.textContent = edge.topic_description || '—';
    topicWrap.append(topicLabel, topicValue);

    const sourcesWrap = document.createElement('div');
    sourcesWrap.className = 'modal-section';
    const sourcesLabel = document.createElement('h3');
    sourcesLabel.className = 'modal-section-title';
    sourcesLabel.textContent = I18n.translate('modalSourcesLabel');
    sourcesWrap.appendChild(sourcesLabel);

    const sources = Array.isArray(edge.sources) ? edge.sources : [];

    if (sources.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'modal-empty';
      empty.textContent = I18n.translate('modalNoSources');
      sourcesWrap.appendChild(empty);
    } else {
      const list = document.createElement('ul');
      list.className = 'source-list';
      sources.forEach((url) => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = url;
        link.textContent = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        item.appendChild(link);
        list.appendChild(item);
      });
      sourcesWrap.appendChild(list);
    }

    elements.modalBody.replaceChildren(direction, topicWrap, sourcesWrap);
  }

  function renderNodeModal(node) {
    elements.modalTitle.textContent = I18n.translate('modalNodeTitle');

    const labelWrap = document.createElement('div');
    labelWrap.className = 'modal-section';
    const labelHeading = document.createElement('h3');
    labelHeading.className = 'modal-section-title';
    labelHeading.textContent = I18n.translate('nodeLabelLabel');
    const labelValue = document.createElement('p');
    labelValue.className = 'modal-value';
    labelValue.textContent = node.label;
    labelWrap.append(labelHeading, labelValue);

    const typeWrap = document.createElement('div');
    typeWrap.className = 'modal-section';
    const typeHeading = document.createElement('h3');
    typeHeading.className = 'modal-section-title';
    typeHeading.textContent = I18n.translate('nodeTypeLabel');
    const typeValue = document.createElement('p');
    typeValue.className = 'modal-value';
    typeValue.textContent = node.type || 'person';
    typeWrap.append(typeHeading, typeValue);

    elements.modalBody.replaceChildren(labelWrap, typeWrap);
  }

  function showModal() {
    elements.modal.hidden = false;
    document.body.classList.add('modal-open');
  }

  function closeModal() {
    elements.modal.hidden = true;
    document.body.classList.remove('modal-open');
    state.modalType = null;
    state.modalData = null;
  }


  /** @returns {Object} the data-* attributes of the network container. */
  function networkDataset() {
    return elements.network && elements.network.dataset ? elements.network.dataset : {};
  }

  /** @returns {string} the endpoint providing the graph for this page. */
  function graphSource() {
    return String(networkDataset().source || '').trim();
  }

  /** @returns {string} the endpoint that appends relations to a saved map. */
  function parseEndpoint() {
    return String(networkDataset().parseEndpoint || '').trim();
  }

  /** @returns {string} the endpoint that empties a saved map. */
  function clearEndpoint() {
    return String(networkDataset().clearEndpoint || '').trim();
  }

  async function loadInitialGraph() {
    const source = graphSource();

    if (source === '') {
      setNetworkMessage('networkEmpty');
      return;
    }

    setNetworkMessage('networkLoading');

    try {
      const response = await fetch(source, { headers: { Accept: 'application/json' } });

      if (!response.ok) {
        throw new Error(`GET ${source} failed with status ${response.status}`);
      }

      const payload = await response.json();

      renderGraph({ nodes: payload.nodes || [], edges: payload.edges || [] });
    } catch (err) {
      console.error('Failed to load the graph:', err);

      if (typeof global.vis === 'undefined') {
        reportGraphProblem('networkLibraryError');
        return;
      }

      reportGraphProblem('networkError');
    }
  }

  /**
   * Wait for vis-network. views/layout.html loads it from a CDN (with a fallback
   * source), so on a slow or filtered mobile connection it may still be on its
   * way when this script starts.
   *
   * @returns {Promise<boolean>} resolves true once the library is available.
   */
  function waitForVisLibrary() {
    if (global.vis) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let timer = null;
      let settled = false;

      const handleReady = () => finish(true);
      const handleError = () => finish(false);

      function finish(available) {
        if (settled) {
          return;
        }

        settled = true;

        if (timer !== null) {
          global.clearTimeout(timer);
        }

        document.removeEventListener('vis:ready', handleReady);
        document.removeEventListener('vis:error', handleError);
        resolve(available);
      }

      document.addEventListener('vis:ready', handleReady);
      document.addEventListener('vis:error', handleError);
      timer = global.setTimeout(() => finish(false), VIS_LIBRARY_TIMEOUT_MS);
    });
  }

  async function handleParse() {
    const text = elements.textarea.value;
    const endpoint = parseEndpoint();

    if (endpoint === '') {
      return;
    }

    if (!text || text.trim() === '') {
      global.alert(I18n.translate('errorEmptyInput'));
      return;
    }

    const button = elements.parseButton;
    button.disabled = true;
    button.textContent = I18n.translate('parseButtonLoading');

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // "replace": the textarea carries the relations already saved in the
        // map, so saving writes the whole set (lines may be added or removed).
        body: JSON.stringify({ text, mode: 'replace' }),
      });

      if (!response.ok) {
        // A 400 carries the offending lines: nothing was saved, so tell the
        // editor how many lines have to be fixed instead of blaming them all.
        const problem = await response.json().catch(() => null);
        const invalidLines = problem && Array.isArray(problem.invalidLines) ? problem.invalidLines.length : 0;

        if (invalidLines > 0) {
          global.alert(I18n.translate('errorInvalidLines', { count: invalidLines }));
        } else {
          global.alert(I18n.translate(response.status === 400 ? 'errorNoValidLines' : 'errorRequestFailed'));
        }

        return;
      }

      const payload = await response.json();
      renderGraph({ nodes: payload.nodes || [], edges: payload.edges || [] });
      // The textarea keeps exactly what was saved, so it stays copyable.
    } catch (err) {
      console.error('Parse request failed:', err);
      global.alert(I18n.translate('errorRequestFailed'));
    } finally {
      button.disabled = false;
      button.textContent = I18n.translate('parseButton');
    }
  }

  async function handleClear() {
    const button = elements.clearButton;
    const endpoint = clearEndpoint();

    if (endpoint === '') {
      return;
    }

    if (!global.confirm(I18n.translate('confirmClear'))) {
      return;
    }

    button.disabled = true;
    button.textContent = I18n.translate('clearingButton');

    try {
      const response = await fetch(endpoint, { method: 'DELETE' });

      if (!response.ok) {
        throw new Error(`DELETE ${endpoint} failed with status ${response.status}`);
      }

      renderGraph({ nodes: [], edges: [] });
    } catch (err) {
      console.error('Clear request failed:', err);
      global.alert(I18n.translate('errorClearFailed'));
    } finally {
      button.disabled = false;
      button.textContent = I18n.translate('clearButton');
    }
  }

  /**
   * Copy a piece of text to the clipboard, falling back to a hidden textarea on
   * browsers that do not expose the asynchronous Clipboard API.
   *
   * @param {string} text
   * @returns {Promise<void>}
   */
  async function copyTextToClipboard(text) {
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      await global.navigator.clipboard.writeText(text);
      return;
    }

    const helper = document.createElement('textarea');
    helper.value = text;
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
  }

  /**
   * Show the "copied" label on a button for a moment, then restore its own one.
   *
   * @param {HTMLElement} button
   * @param {string} idleKey i18n key of the button's regular label
   */
  function flashCopiedLabel(button, idleKey) {
    button.textContent = I18n.translate('copyLinkDone');
    global.setTimeout(() => {
      button.textContent = I18n.translate(idleKey);
    }, 2000);
  }

  async function handleCopyMapUrl() {
    const button = elements.copyMapUrl;
    const url = button.dataset.mapUrl || '';

    if (url === '') {
      return;
    }

    try {
      await copyTextToClipboard(url);
      flashCopiedLabel(button, 'copyLinkButton');
    } catch (err) {
      console.error('Could not copy the map URL:', err);
    }
  }

  /**
   * Copy the relations shown in the editor: the data loaded for this map plus
   * anything added or removed since, so it can be pasted somewhere else.
   */
  async function handleCopyRelations() {
    const button = elements.copyRelations;
    const text = elements.textarea ? elements.textarea.value : '';

    if (text === '') {
      return;
    }

    try {
      await copyTextToClipboard(text);
      flashCopiedLabel(button, 'copyRelationsButton');
    } catch (err) {
      console.error('Could not copy the relations:', err);
    }
  }

  /**
   * Middle mouse button on the graph area: reset the zoom and frame the whole
   * graph again, exactly as the help popup promises.
   *
   * @param {MouseEvent} event
   */
  function handleGraphMiddleClick(event) {
    if (event.button !== 1 || !state.network) {
      return;
    }

    // Also stops the browser's middle-click auto-scroll from hijacking it.
    event.preventDefault();
    state.network.fit(fitOptions(true));
  }

  function bindEvents() {
    if (elements.parseButton && elements.textarea) {
      elements.parseButton.addEventListener('click', handleParse);
    }

    if (elements.clearButton) {
      elements.clearButton.addEventListener('click', handleClear);
    }

    if (elements.copyMapUrl) {
      elements.copyMapUrl.addEventListener('click', handleCopyMapUrl);
    }

    if (elements.copyRelations) {
      elements.copyRelations.addEventListener('click', handleCopyRelations);
    }

    if (elements.network) {
      elements.network.addEventListener('mousedown', handleGraphMiddleClick);
    }

    elements.modalClose.addEventListener('click', closeModal);

    // Clicking the dimmed overlay (but not the card) closes the modal.
    elements.modal.addEventListener('click', (event) => {
      if (event.target === elements.modal) {
        closeModal();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !elements.modal.hidden) {
        closeModal();
      }
    });

    // Rebuild the graph with the palette of the newly selected theme.
    document.addEventListener('themechange', () => {
      if (state.network) {
        renderGraph(state.graph);
      }
    });

    // After a locale switch, refresh the modal (if open) and any fallback text.
    I18n.onLocaleChange(() => {
      if (state.modalType) {
        renderModal();
      }

      if (state.networkMessage) {
        setNetworkMessage(state.networkMessage, state.networkMessageVars);
      }
    });

    // Phones resize the viewport while the address bar moves: keep the canvas in
    // sync there, but never re-frame the graph (that would look like jitter).
    global.addEventListener('resize', () => {
      applyCompactHeight();

      if (!state.network) {
        return;
      }

      if (state.resizeTimer) {
        global.clearTimeout(state.resizeTimer);
      }

      state.resizeTimer = global.setTimeout(() => {
        state.resizeTimer = null;
        ensureNetworkSize(state.network, { fit: false });
      }, 150);
    });

    // Rotating the device changes the aspect ratio, so re-frame the graph once.
    global.addEventListener('orientationchange', () => {
      applyCompactHeight();

      if (!state.network) {
        return;
      }

      global.setTimeout(() => {
        ensureNetworkSize(state.network, { fit: true, animated: true });
      }, 350);
    });
  }

  async function init() {
    if (!elements.network) {
      // Pages without a graph (home without a selected map) render their own
      // placeholder server-side, so there is nothing to do here.
      return;
    }

    bindEvents();
    applyCompactHeight();
    await I18n.ready();

    if (!(await waitForVisLibrary())) {
      reportGraphProblem('networkLibraryError');
      return;
    }

    await loadInitialGraph();
  }

  init().catch((err) => {
    console.error('Frontend initialization failed:', err);
  });
})(window);

