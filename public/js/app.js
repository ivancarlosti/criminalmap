/* global vis, I18n */
(function () {
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

  const state = {
    network: null,
    graph: { nodes: [], edges: [] },
    modalType: null, // 'edge' | 'node' | null
    modalData: null,
    networkMessage: null, // 'networkLoading' | 'networkError' | null
  };

  const elements = {
    network: document.getElementById('network'),
    textarea: document.getElementById('relation-input'),
    parseButton: document.getElementById('parse-button'),
    langSelect: document.getElementById('lang-select'),
    modal: document.getElementById('edge-modal'),
    modalTitle: document.getElementById('modal-title'),
    modalBody: document.getElementById('modal-body'),
    modalClose: document.getElementById('modal-close'),
  };

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
        font: { color: '#211d19', face: 'monospace', size: 14 },
        borderWidth: 2,
        borderWidthSelected: 3,
        shadow: { enabled: true, color: 'rgba(0, 0, 0, 0.45)', size: 8, x: 2, y: 3 },
        margin: 12,
      };
    }));
  }

  function buildEdgeDataSet(edges, nodes) {
    const labelById = new Map(nodes.map((node) => [node.id, node.label]));

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
          color: '#e6b84c',
          highlight: '#ffe082',
          hover: '#fff59d',
          opacity: 0.9,
        },
        width: 2,
        selectionWidth: 3,
        font: {
          color: '#d8c9a3',
          face: 'monospace',
          size: 11,
          align: 'top',
          strokeWidth: 2,
          strokeColor: '#0d0d0d',
        },
      };
    }));
  }

  function buildOptions() {
    return {
      autoResize: true,
      physics: {
        enabled: true,
        solver: 'barnesHut',
        barnesHut: {
          gravitationalConstant: -9000,
          centralGravity: 0.2,
          springLength: 180,
          springConstant: 0.04,
          damping: 0.09,
          avoidOverlap: 0.2,
        },
        stabilization: { enabled: true, iterations: 250, fit: true },
      },
      interaction: {
        hover: true,
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

  function renderGraph(graph) {
    state.graph = graph || { nodes: [], edges: [] };
    const nodes = buildNodeDataSet(state.graph.nodes);
    const edges = buildEdgeDataSet(state.graph.edges, state.graph.nodes);

    if (state.network) {
      state.network.setData({ nodes, edges });
      state.network.fit({ animation: { duration: 600, easingFunction: 'easeInOutQuad' } });
      return;
    }

    state.networkMessage = null;
    elements.network.textContent = '';
    state.network = new vis.Network(elements.network, { nodes, edges }, buildOptions());
    state.network.on('click', handleNetworkClick);
  }

  function setNetworkMessage(key) {
    state.networkMessage = key;
    elements.network.textContent = I18n.translate(key);
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

  async function loadInitialGraph() {
    setNetworkMessage('networkLoading');

    try {
      const response = await fetch('/api/graph');
      if (!response.ok) {
        throw new Error(`GET /api/graph failed with status ${response.status}`);
      }
      const graph = await response.json();
      renderGraph(graph);
    } catch (err) {
      console.error('Failed to load initial graph:', err);
      setNetworkMessage('networkError');
    }
  }

  async function handleParse() {
    const text = elements.textarea.value;

    if (!text || text.trim() === '') {
      window.alert(I18n.translate('errorEmptyInput'));
      return;
    }

    const button = elements.parseButton;
    button.disabled = true;
    button.textContent = I18n.translate('parseButtonLoading');

    try {
      const response = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        const message = response.status === 400
          ? I18n.translate('errorNoValidLines')
          : I18n.translate('errorRequestFailed');
        window.alert(message);
        return;
      }

      const graph = await response.json();
      renderGraph(graph);
    } catch (err) {
      console.error('Parse request failed:', err);
      window.alert(I18n.translate('errorRequestFailed'));
    } finally {
      button.disabled = false;
      button.textContent = I18n.translate('parseButton');
    }
  }

  function bindEvents() {
    elements.parseButton.addEventListener('click', handleParse);
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

    elements.langSelect.addEventListener('change', () => {
      I18n.setLocale(elements.langSelect.value);
    });

    // After a locale switch, refresh the modal (if open) and any fallback text.
    I18n.onLocaleChange(() => {
      elements.langSelect.value = I18n.getLocale();
      if (state.modalType) {
        renderModal();
      }
      if (!state.network && state.networkMessage) {
        elements.network.textContent = I18n.translate(state.networkMessage);
      }
    });
  }

  async function init() {
    bindEvents();
    await I18n.init();
    elements.langSelect.value = I18n.getLocale();
    await loadInitialGraph();
  }

  init().catch((err) => {
    console.error('Frontend initialization failed:', err);
  });
})();
