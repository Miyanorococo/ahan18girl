/**
 * Model Grid mixin for Alpine.js gallery component.
 * Provides a side-by-side comparison view of N models that share
 * the same prompt, with seed-based image matching.
 */
function modelGridMixin() {
  // Cache loaded experiment detail data across navigations
  const _experimentCache = {};

  return {
    modelGrid: {
      groups: [],
      selectedGroup: null,
      selectedSeed: null,
      allSeeds: [],
      modelCards: [],
      viewMode: 'single',
      loading: false,
    },

    /**
     * Initialize the model grid view.
     * Groups experiments by normalized prompt_summary, keeping only
     * groups with 2+ distinct models.
     */
    initModelGrid() {
      const groupMap = {};

      for (const exp of this.experiments) {
        if (!exp.prompt_summary) continue;
        const key = exp.prompt_summary.toLowerCase().trim();
        if (!groupMap[key]) {
          groupMap[key] = {
            key,
            prompt: exp.prompt_summary,
            experiments: [],
            models: new Set(),
          };
        }
        groupMap[key].experiments.push(exp);
        if (exp.model) groupMap[key].models.add(exp.model);
      }

      this.modelGrid.groups = Object.values(groupMap)
        .filter((g) => g.models.size >= 2)
        .map((g) => ({
          key: g.key,
          prompt: g.prompt,
          experiments: g.experiments,
          models: [...g.models],
        }))
        .sort((a, b) => b.models.length - a.models.length);

      // Reset selection state
      this.modelGrid.selectedGroup = null;
      this.modelGrid.selectedSeed = null;
      this.modelGrid.allSeeds = [];
      this.modelGrid.modelCards = [];
    },

    /**
     * Select a comparison group and load all its experiments.
     * Builds model cards with seed-indexed images.
     */
    async selectModelGroup(group) {
      this.modelGrid.selectedGroup = group;
      this.modelGrid.loading = true;
      this.modelGrid.modelCards = [];
      this.modelGrid.allSeeds = [];
      this.modelGrid.selectedSeed = null;
      this.modelGrid._loadedCount = 0;
      this.modelGrid._totalCount = group.experiments.length;

      const seedSet = new Set();

      // Progressive loading: show each card as it arrives
      const loadOne = async (exp) => {
        const detail = await this._loadExperimentCached(exp.id);
        if (!detail) return;

        const images = (detail.images || []).map((img, idx) => ({
          ...img,
          _index: idx,
          _seed: this._extractSeed(img.name),
        }));

        const seedMap = {};
        for (const img of images) {
          if (img._seed) {
            seedSet.add(img._seed);
            seedMap[img._seed] = img;
          }
        }

        const card = {
          model: exp.model,
          experiment: exp,
          detail,
          images,
          seedMap,
          seeds: images.map((img) => img._seed).filter(Boolean),
        };

        // Insert card and update seeds reactively
        this.modelGrid.modelCards = [...this.modelGrid.modelCards, card];
        this.modelGrid.allSeeds = [...seedSet].sort(
          (a, b) => parseInt(a, 10) - parseInt(b, 10)
        );
        this.modelGrid._loadedCount++;

        // Auto-select first seed once available
        if (!this.modelGrid.selectedSeed && this.modelGrid.allSeeds.length > 0) {
          this.modelGrid.selectedSeed = this.modelGrid.allSeeds[0];
        }

        // Hide spinner after first card loads
        if (this.modelGrid._loadedCount === 1) {
          this.modelGrid.loading = false;
        }
      };

      // Fire all loads in parallel, each updates UI on completion
      try {
        await Promise.all(group.experiments.map(exp => loadOne(exp)));
      } catch (e) {
        console.error('Failed to load model group:', e);
      }
      this.modelGrid.loading = false;
    },

    /**
     * Select a specific seed for single-seed view.
     */
    selectSeed(seed) {
      this.modelGrid.selectedSeed = seed;
    },

    /**
     * Get the image for the currently selected seed from a model card.
     * Falls back to the first image if no seed is selected or no match found.
     */
    getCardImage(card) {
      if (this.modelGrid.selectedSeed && card.seedMap[this.modelGrid.selectedSeed]) {
        return card.seedMap[this.modelGrid.selectedSeed];
      }
      return card.images[0] || null;
    },

    /**
     * Get all images for a card (used in "all seeds" view).
     */
    getCardImages(card) {
      return card.images;
    },

    /**
     * Load an experiment via API with caching.
     */
    async _loadExperimentCached(id) {
      if (_experimentCache[id]) return _experimentCache[id];
      try {
        const data = await GalleryAPI.getExperiment(id);
        _experimentCache[id] = data;
        return data;
      } catch (e) {
        console.error(`Failed to load experiment ${id}:`, e);
        return null;
      }
    },
  };
}
