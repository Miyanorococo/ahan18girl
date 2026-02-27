/**
 * Model Grid mixin for Alpine.js gallery component.
 * Two-level navigation: Theme filter → Scene groups → Seed-based model comparison.
 *
 * Data flow:
 *   experiments[].prompt_id  "P01_ex"  → themeNum="01", scene="ex"
 *   experiments[].id         "20260215_model/P01_ex" → runDate="20260215"
 *   groupKey = "{runDate}/{prompt_id}"  → one group per scene per run
 */
function modelGridMixin() {
  const _experimentCache = {};

  const SCENE_LABELS = {
    ex: 'ベース', se: 'センシティブ', sex: 'セックス',
    ejac: '射精', birth: '出産', lactation: '母乳',
    orgasm: 'オーガズム', penis: 'ペニス', pregnant: '妊娠', toy: '玩具',
  };

  function extractRunDate(exp) {
    const m = (exp.id || '').match(/^(\d{8})_/);
    if (m) return m[1];
    if (exp.created_at) return exp.created_at.slice(0, 10).replace(/-/g, '');
    return 'unknown';
  }

  function extractThemeName(summary) {
    if (!summary) return '?';
    // "人妻_explicit" → "人妻",  "JK/学園_sensitive" → "JK/学園"
    const idx = summary.lastIndexOf('_');
    return idx > 0 ? summary.slice(0, idx) : summary;
  }

  // Extract theme from old-format prompt_id like
  // "20260215_animagine-xl-4.0_txt2img_lingerie-tease_seed42x5"
  function extractLegacyTheme(pid) {
    const m = pid.match(/txt2img_(.+?)_(?:s\d|seed)/);
    return m ? m[1] : null;
  }

  return {
    modelGrid: {
      themes: [],
      selectedTheme: null,
      groups: [],
      selectedGroup: null,
      selectedSeed: null,
      allSeeds: [],
      modelCards: [],
      viewMode: 'single',
      loading: false,
    },

    /**
     * Build theme list and scene groups from experiments.
     */
    initModelGrid() {
      const groupMap = {};

      for (const exp of this.experiments) {
        if (!exp.model) continue;
        const pid = exp.prompt_id || '';
        if (!pid) continue;

        const runDate = extractRunDate(exp);
        let key, themeNum, themeName, scene, sceneLabel;

        // 1. Book format: "0219a_S07_evening" or "0219a_R1_S01b_library"
        const bookMatch = pid.match(/^(\d{4}[a-z]+)_(?:R\d+_)?(.+)$/);
        // 2. Structured eval: "P01_ex", "UP01_ex"
        const evalMatch = !bookMatch && pid.match(/^([A-Z]+)(\d+)_(.+)$/);

        if (bookMatch) {
          const bookId = bookMatch[1];
          // Scene key: strip regen prefix for grouping (R1_S01b_library → S01b_library)
          scene = bookMatch[2];
          sceneLabel = SCENE_LABELS[scene] || scene;
          // Group by bookId + scene (across dates/models)
          key = bookId + '/' + scene;
          themeNum = bookId;
          // Theme = genre or bookId
          themeName = exp.genre || extractThemeName(exp.prompt_summary) || bookId;
        } else if (evalMatch) {
          key = runDate + '/' + pid;
          themeNum = evalMatch[1] + evalMatch[2];
          scene = evalMatch[3];
          sceneLabel = SCENE_LABELS[scene] || scene;
          themeName = extractThemeName(exp.prompt_summary);
        } else {
          const theme = exp.prompt_summary || extractLegacyTheme(pid);
          if (!theme) continue;
          key = runDate + '/legacy_' + theme;
          themeNum = 'L';
          scene = theme;
          sceneLabel = theme;
          themeName = 'Legacy';
        }

        if (!groupMap[key]) {
          groupMap[key] = {
            key,
            themeNum,
            themeName,
            scene,
            sceneLabel,
            runDate,
            prompt: exp.prompt_summary || scene,
            _exps: [],
            _models: new Set(),
          };
        }
        groupMap[key]._exps.push(exp);
        groupMap[key]._models.add(exp.model);
      }

      // Finalize groups (2+ models only)
      const allGroups = [];
      for (const g of Object.values(groupMap)) {
        if (g._models.size < 2) continue;
        // Deduplicate: keep latest experiment per model
        const latest = {};
        for (const exp of g._exps) {
          const prev = latest[exp.model];
          if (!prev || (exp.created_at || '') > (prev.created_at || '')) {
            latest[exp.model] = exp;
          }
        }
        const exps = Object.values(latest);
        // Find latest created_at across all experiments in this group
        const latestTime = exps.reduce((max, e) =>
          (e.created_at || '') > max ? (e.created_at || '') : max, '');
        allGroups.push({
          key: g.key,
          themeNum: g.themeNum,
          themeName: g.themeName,
          scene: g.scene,
          sceneLabel: g.sceneLabel,
          runDate: g.runDate,
          latestTime,
          prompt: g.prompt,
          experiments: exps,
          models: exps.map((e) => e.model),
        });
      }

      // Sort by theme name → scene name
      allGroups.sort((a, b) => {
        const t = a.themeName.localeCompare(b.themeName);
        return t !== 0 ? t : a.scene.localeCompare(b.scene);
      });

      // Build theme list (group by display name, not prefix+number)
      const themeMap = {};
      for (const g of allGroups) {
        const tname = g.themeName;
        if (!themeMap[tname]) {
          themeMap[tname] = { id: tname, name: tname, count: 0 };
        }
        themeMap[tname].count++;
      }

      this.modelGrid.themes = Object.values(themeMap).sort((a, b) => a.name.localeCompare(b.name));
      this.modelGrid.groups = allGroups;

      // Reset
      this.modelGrid.selectedTheme = null;
      this.modelGrid.selectedGroup = null;
      this.modelGrid.selectedSeed = null;
      this.modelGrid.allSeeds = [];
      this.modelGrid.modelCards = [];
    },

    /**
     * Return groups filtered by selected theme.
     */
    getFilteredGroups() {
      const t = this.modelGrid.selectedTheme;
      if (!t) return this.modelGrid.groups;
      return this.modelGrid.groups.filter((g) => g.themeName === t);
    },

    /**
     * Toggle theme filter.
     */
    selectTheme(themeId) {
      this.modelGrid.selectedTheme = this.modelGrid.selectedTheme === themeId ? null : themeId;
    },

    /**
     * Format run date for display: "20260215" → "2/15"
     */
    formatRunDate(d) {
      if (!d || d.length !== 8) return d;
      return parseInt(d.slice(4, 6), 10) + '/' + parseInt(d.slice(6, 8), 10);
    },

    /**
     * Select a comparison group and load experiments + seeds.
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

        const cards = [...this.modelGrid.modelCards, card];
        cards.sort((a, b) => a.model.localeCompare(b.model));
        this.modelGrid.modelCards = cards;
        this.modelGrid.allSeeds = [...seedSet].sort(
          (a, b) => parseInt(a, 10) - parseInt(b, 10)
        );
        this.modelGrid._loadedCount++;

        if (!this.modelGrid.selectedSeed && this.modelGrid.allSeeds.length > 0) {
          this.modelGrid.selectedSeed = this.modelGrid.allSeeds[0];
        }
        if (this.modelGrid._loadedCount === 1) {
          this.modelGrid.loading = false;
        }
      };

      try {
        await Promise.all(group.experiments.map((exp) => loadOne(exp)));
      } catch (e) {
        console.error('Failed to load model group:', e);
      }
      this.modelGrid.loading = false;
    },

    selectSeed(seed) {
      this.modelGrid.selectedSeed = seed;
    },

    getCardImage(card) {
      let img = null;
      if (this.modelGrid.selectedSeed) {
        img = card.seedMap[this.modelGrid.selectedSeed] || null;
      } else {
        img = card.images[0] || null;
      }
      // Attach experiment detail for AI score lookup
      if (img && !img._mgExperiment) {
        img._mgExperiment = card.detail;
      }
      return img;
    },

    getCardImages(card) {
      return card.images;
    },

    _buildCrossModelImages(seed) {
      const images = [];
      for (const card of this.modelGrid.modelCards) {
        const img = seed ? card.seedMap[seed] : card.images[0];
        if (!img) continue;
        images.push({ ...img, _mgModel: card.model, _mgExperiment: card.detail });
      }
      return images;
    },

    openModelGridLightbox(card) {
      const seed = this.modelGrid.selectedSeed;
      const crossImages = this._buildCrossModelImages(seed);
      const idx = crossImages.findIndex((img) => img._mgModel === card.model);
      this.openLightbox(Math.max(0, idx), 'model-grid', crossImages, card.detail);
    },

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
