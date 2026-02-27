const GALLERY_BASE = (() => {
  // Use relative path when served from same origin; otherwise derive from current host
  if (location.hostname.includes('cloudfront') || location.hostname.includes('amazonaws')) {
    return '/gallery/experiments';
  }
  return `${location.protocol}//${location.host}/gallery/experiments`;
})();

const MODELS = [
  { key: 'wai-v16', prefix: 'layer2', label: 'WAI-NSFW v16', color: '#8ab4f8' },
  { key: 'animagine', prefix: 'layer2-animagine-xl-4.0', label: 'Animagine XL 4.0', color: '#81c995' },
];

document.addEventListener('alpine:init', () => {
  Alpine.data('layer2App', () => ({
    models: MODELS,
    activeModel: MODELS[0].key,
    index: null,
    loading: true,
    activeTech: 'all',
    openGroups: {},
    _metaStore: new Map(),
    _imageStore: new Map(),
    lightbox: {
      open: false,
      src: '',
      label: '',
      idx: 0,
      images: [],
      tech: '',
      testId: '',
    },

    get currentPrefix() {
      return this.models.find(m => m.key === this.activeModel)?.prefix || 'layer2';
    },

    get baseUrl() {
      return `${GALLERY_BASE}/${this.currentPrefix}`;
    },

    async init() {
      await this.loadModel(this.activeModel);
    },

    async switchModel(key) {
      if (key === this.activeModel) return;
      this.activeModel = key;
      this.loading = true;
      this._metaStore = new Map();
      this._imageStore = new Map();
      this.openGroups = {};
      this.activeTech = 'all';
      await this.loadModel(key);
    },

    async loadModel(key) {
      this.loading = true;
      try {
        const prefix = this.models.find(m => m.key === key)?.prefix || 'layer2';
        const resp = await fetch(`${GALLERY_BASE}/${prefix}/index.json`);
        if (resp.ok) {
          this.index = await resp.json();
          for (const [tech, group] of Object.entries(this.index.test_groups || {})) {
            if (group.tests && group.tests.length > 0) {
              this.openGroups[`${tech}_${group.tests[0].id}`] = true;
            }
          }
          await this.loadAllMetadata();
        } else {
          this.index = null;
        }
      } catch (e) {
        console.error('Failed to load index:', e);
        this.index = null;
      }
      this.loading = false;
    },

    async loadAllMetadata() {
      const promises = [];
      for (const [tech, group] of Object.entries(this.index.test_groups || {})) {
        for (const test of group.tests || []) {
          promises.push(this.loadTestMetadata(tech, test.id));
        }
      }
      await Promise.allSettled(promises);
    },

    async loadTestMetadata(tech, testId) {
      const key = `${tech}_${testId}`;
      try {
        const resp = await fetch(`${this.baseUrl}/${tech}/${testId}/metadata.json`);
        if (resp.ok) {
          const data = await resp.json();
          this._metaStore.set(key, data);
          if (data?.layer2?.image_labels) {
            this._imageStore.set(key, Object.keys(data.layer2.image_labels));
          }
        }
      } catch (e) {
        console.warn(`Failed to load metadata for ${key}:`, e);
      }
    },

    _getMeta(key) {
      return this._metaStore.get(key) || null;
    },

    _getImages(key) {
      return this._imageStore.get(key) || [];
    },

    get totalImages() {
      let count = 0;
      for (const group of Object.values(this.index?.test_groups || {})) {
        for (const test of group.tests || []) {
          count += test.image_count || 0;
        }
      }
      return count;
    },

    get modelLabel() {
      return this.models.find(m => m.key === this.activeModel)?.label || '';
    },

    techImageCount(tech) {
      const group = this.index?.test_groups?.[tech];
      if (!group) return 0;
      return (group.tests || []).reduce((sum, t) => sum + (t.image_count || 0), 0);
    },

    filteredGroups() {
      if (!this.index) return {};
      if (this.activeTech === 'all') return this.index.test_groups;
      const result = {};
      if (this.index.test_groups[this.activeTech]) {
        result[this.activeTech] = this.index.test_groups[this.activeTech];
      }
      return result;
    },

    toggleGroup(key) {
      this.openGroups[key] = !this.openGroups[key];
    },

    isGroupOpen(key) {
      return !!this.openGroups[key];
    },

    getTestMeta(tech, testId) {
      return this._getMeta(`${tech}_${testId}`);
    },

    getLayout(tech, testId) {
      const meta = this.getTestMeta(tech, testId);
      return meta?.layer2?.display_layout ||
             this.index?.test_groups?.[tech]?.display_layout || 'grid';
    },

    getTestImages(tech, testId) {
      return this._getImages(`${tech}_${testId}`);
    },

    getThumbUrl(tech, testId, filename) {
      const thumbName = filename.replace(/\.png$/, '.webp');
      return `${this.baseUrl}/${tech}/${testId}/thumb/${thumbName}`;
    },

    getFullUrl(tech, testId, filename) {
      return `${this.baseUrl}/${tech}/${testId}/full/${filename}`;
    },

    getImageLabel(tech, testId, filename) {
      const meta = this.getTestMeta(tech, testId);
      return meta?.layer2?.image_labels?.[filename] || filename.replace(/\.(png|webp)$/, '');
    },

    getBeforeAfterPairs(tech, testId) {
      const images = this.getTestImages(tech, testId);
      const pairs = [];
      for (let i = 0; i < images.length - 1; i += 2) {
        pairs.push({
          before: images[i],
          after: images[i + 1],
          beforeIdx: i,
          afterIdx: i + 1,
        });
      }
      return pairs;
    },

    openLightbox(tech, testId, idx) {
      const images = this.getTestImages(tech, testId);
      if (!images.length) return;
      this.lightbox.tech = tech;
      this.lightbox.testId = testId;
      this.lightbox.images = images;
      this.lightbox.idx = idx;
      this.lightbox.src = this.getFullUrl(tech, testId, images[idx]);
      this.lightbox.label = this.getImageLabel(tech, testId, images[idx]);
      this.lightbox.open = true;
    },

    lightboxPrev() {
      if (this.lightbox.idx > 0) {
        this.lightbox.idx--;
        const img = this.lightbox.images[this.lightbox.idx];
        this.lightbox.src = this.getFullUrl(this.lightbox.tech, this.lightbox.testId, img);
        this.lightbox.label = this.getImageLabel(this.lightbox.tech, this.lightbox.testId, img);
      }
    },

    lightboxNext() {
      if (this.lightbox.idx < this.lightbox.images.length - 1) {
        this.lightbox.idx++;
        const img = this.lightbox.images[this.lightbox.idx];
        this.lightbox.src = this.getFullUrl(this.lightbox.tech, this.lightbox.testId, img);
        this.lightbox.label = this.getImageLabel(this.lightbox.tech, this.lightbox.testId, img);
      }
    },
  }));
});
