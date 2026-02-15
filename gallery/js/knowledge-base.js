/**
 * Knowledge Base mixin for Alpine.js gallery component.
 * Auto-computes model decision matrices, prompt quality rankings,
 * and quick recommendations from evaluation ratings.
 */
function knowledgeBaseMixin() {
  return {
    kb: {
      loading: false,
      activeTab: 'recommend', // 'recommend' | 'matrix' | 'prompts'
      // Quick Recommendation
      selectedGenre: '',
      selectedType: '',
      recommendation: null, // { model, score, count, favRate, topPrompt, sampleImage }
      // Decision Matrix
      matrix: null,  // { genres[], models[], cells: { genre: { model: { avg, count, favCount } } } }
      matrixDrillGenre: null, // clicked genre for type-level drill-down
      matrixDrill: null, // { types[], models[], cells }
      // Prompt Library
      promptRankings: [],
      promptFilter: '',
      promptSort: 'score', // 'score' | 'favRate' | 'genre'
      // Computed data cache
      _cache: null,
    },

    initKnowledgeBase() {
      this.kb.loading = true;
      this._computeKBData();
      this.kb.loading = false;
    },

    // =========================================================================
    // Core computation (shared data, computed once)
    // =========================================================================

    _invalidateKBCache() {
      this.kb._cache = null;
    },

    _computeKBData() {
      if (this.kb._cache) return; // already computed

      // Pre-compiled regex (avoid re-compilation per iteration)
      const expPathRegex = /gallery\/experiments\/(.+?)\/(full|thumb)\//;

      // Build experiment → model map (from index, no extra API calls)
      const expModelMap = {};
      const expGenreMap = {};
      const expTypeMap = {};
      const expPromptIdMap = {};
      for (const exp of this.experiments) {
        if (!exp.id || !exp.model) continue;
        expModelMap[exp.id] = exp.model;
        expGenreMap[exp.id] = (exp.genre || (exp.prompt_summary || '').split('_')[0] || 'other').toLowerCase();
        expTypeMap[exp.id] = exp.content_type || (exp.prompt_summary || '').split('_').slice(1).join('_') || 'unknown';
        expPromptIdMap[exp.id] = exp.prompt_id || exp.id.split('/').pop() || '';
      }

      // Aggregate: model × genre, model × genre × type, prompt rankings
      const modelGenre = {};     // model → genre → { sum, count, favCount }
      const modelGenreType = {}; // model → genre → type → { sum, count, favCount }
      const promptScores = {};   // promptId → { sum, count, favCount, genre, type, models: { model: avg } }
      const allGenres = new Set();
      const allTypes = new Set();
      const allModels = new Set();

      for (const [key, entry] of Object.entries(this.ratings.images || {})) {
        if (!entry || typeof entry !== 'object' || !entry.scores || typeof entry.scores !== 'object') continue;
        const overall = entry.scores.overall;
        if (!overall || overall <= 0) continue;

        // Extract experiment ID from rating key path
        const match = key.match(expPathRegex);
        if (!match) continue;
        const expId = match[1];
        const model = expModelMap[expId];
        if (!model) continue;

        const genre = expGenreMap[expId] || 'other';
        const type = expTypeMap[expId] || 'unknown';
        const promptId = expPromptIdMap[expId] || '';
        const fav = entry.favorited ? 1 : 0;

        allGenres.add(genre);
        allTypes.add(type);
        allModels.add(model);

        // model × genre
        if (!modelGenre[model]) modelGenre[model] = {};
        if (!modelGenre[model][genre]) modelGenre[model][genre] = { sum: 0, count: 0, favCount: 0 };
        modelGenre[model][genre].sum += overall;
        modelGenre[model][genre].count++;
        modelGenre[model][genre].favCount += fav;

        // model × genre × type
        if (!modelGenreType[model]) modelGenreType[model] = {};
        if (!modelGenreType[model][genre]) modelGenreType[model][genre] = {};
        if (!modelGenreType[model][genre][type]) modelGenreType[model][genre][type] = { sum: 0, count: 0, favCount: 0 };
        modelGenreType[model][genre][type].sum += overall;
        modelGenreType[model][genre][type].count++;
        modelGenreType[model][genre][type].favCount += fav;

        // prompt rankings
        if (promptId) {
          if (!promptScores[promptId]) promptScores[promptId] = { sum: 0, count: 0, favCount: 0, genre, type, models: {} };
          promptScores[promptId].sum += overall;
          promptScores[promptId].count++;
          promptScores[promptId].favCount += fav;
          if (!promptScores[promptId].models[model]) promptScores[promptId].models[model] = { sum: 0, count: 0 };
          promptScores[promptId].models[model].sum += overall;
          promptScores[promptId].models[model].count++;
        }
      }

      this.kb._cache = { modelGenre, modelGenreType, promptScores, allGenres, allTypes, allModels, expModelMap };
      this._buildMatrix();
      this._buildPromptRankings();
    },

    // =========================================================================
    // Decision Matrix (genre-level, default view)
    // =========================================================================

    _buildMatrix() {
      const { modelGenre, allGenres, allModels } = this.kb._cache;
      const genres = [...allGenres].sort();
      const models = [...allModels].sort();

      // For each genre, find the winning model
      const cells = {};
      for (const genre of genres) {
        cells[genre] = {};
        for (const model of models) {
          const data = modelGenre[model]?.[genre];
          cells[genre][model] = data ? {
            avg: +(data.sum / data.count).toFixed(2),
            count: data.count,
            favCount: data.favCount,
            favRate: data.count > 0 ? +(data.favCount / data.count * 100).toFixed(1) : 0,
          } : { avg: 0, count: 0, favCount: 0, favRate: 0 };
        }
      }

      this.kb.matrix = { genres, models, cells };
    },

    matrixWinner(genre) {
      if (!this.kb.matrix) return null;
      const cells = this.kb.matrix.cells[genre];
      if (!cells) return null;
      let best = null;
      for (const [model, data] of Object.entries(cells)) {
        if (data.count > 0 && (!best || data.avg > best.avg)) {
          best = { model, ...data };
        }
      }
      return best;
    },

    matrixCellColor(avg) {
      if (avg <= 0) return 'rgba(128,128,128,0.2)';
      const t = Math.max(0, Math.min(1, (avg - 1) / 4)); // 1-5 → 0-1
      const r = Math.round(255 * (1 - t));
      const g = Math.round(255 * t);
      return `rgba(${r}, ${g}, 80, 0.3)`;
    },

    shortModelName(model) {
      return model
        .replace('wai-nsfw-illustrious-', 'WAI ')
        .replace('wai-branch-rouwei', 'Rouwei')
        .replace('illustrij-v20', 'Illustrij')
        .replace('nova-anime-xl-il', 'Nova')
        .replace('autismmix-sdxl', 'Autism')
        .replace('pony-diffusion-v6-xl', 'Pony')
        .replace('animagine-xl-4.0', 'Animag')
        .replace('femix-hassakuxl', 'FeMix')
        .replace('dreamshaper-8', 'Dream8')
        .replace('aam-anylora-anime-mix', 'AAM');
    },

    // Drill-down: click genre → show type breakdown
    drillIntoGenre(genre) {
      if (this.kb.matrixDrillGenre === genre) {
        this.kb.matrixDrillGenre = null;
        this.kb.matrixDrill = null;
        return;
      }
      const { modelGenreType, allModels } = this.kb._cache;
      const models = [...allModels].sort();
      const typesSet = new Set();
      for (const model of models) {
        const genreData = modelGenreType[model]?.[genre];
        if (genreData) Object.keys(genreData).forEach(t => typesSet.add(t));
      }
      const types = [...typesSet].sort();
      const cells = {};
      for (const type of types) {
        cells[type] = {};
        for (const model of models) {
          const data = modelGenreType[model]?.[genre]?.[type];
          cells[type][model] = data ? {
            avg: +(data.sum / data.count).toFixed(2),
            count: data.count,
            favCount: data.favCount,
          } : { avg: 0, count: 0, favCount: 0 };
        }
      }
      this.kb.matrixDrillGenre = genre;
      this.kb.matrixDrill = { types, models, cells };
    },

    // =========================================================================
    // Quick Recommendation
    // =========================================================================

    computeRecommendation() {
      if (!this.kb._cache) return;
      const genre = this.kb.selectedGenre;
      const type = this.kb.selectedType;
      if (!genre) { this.kb.recommendation = null; return; }

      const { modelGenre, modelGenreType, promptScores, allModels } = this.kb._cache;
      const models = [...allModels];

      // Find best model for genre (or genre+type)
      let best = null;
      for (const model of models) {
        let data;
        if (type) {
          data = modelGenreType[model]?.[genre]?.[type];
        } else {
          data = modelGenre[model]?.[genre];
        }
        if (!data || data.count === 0) continue;
        const avg = data.sum / data.count;
        const favRate = data.favCount / data.count * 100;
        if (!best || avg > best.score) {
          best = { model, score: +avg.toFixed(2), count: data.count, favRate: +favRate.toFixed(1), favCount: data.favCount };
        }
      }

      // Find top prompt for this genre+type
      let topPrompt = null;
      for (const [pid, pdata] of Object.entries(promptScores)) {
        if (pdata.genre !== genre) continue;
        if (type && pdata.type !== type) continue;
        const avg = pdata.sum / pdata.count;
        if (!topPrompt || avg > topPrompt.avg) {
          topPrompt = { id: pid, avg: +avg.toFixed(2), count: pdata.count, favCount: pdata.favCount };
        }
      }

      this.kb.recommendation = best ? { ...best, topPrompt } : null;
    },

    // =========================================================================
    // Prompt Library
    // =========================================================================

    _buildPromptRankings() {
      const { promptScores } = this.kb._cache;
      const rankings = [];
      for (const [pid, data] of Object.entries(promptScores)) {
        const avg = data.count > 0 ? +(data.sum / data.count).toFixed(2) : 0;
        const favRate = data.count > 0 ? +(data.favCount / data.count * 100).toFixed(1) : 0;
        // Per-model breakdown
        const modelBreakdown = {};
        for (const [model, mdata] of Object.entries(data.models)) {
          modelBreakdown[model] = +(mdata.sum / mdata.count).toFixed(2);
        }
        rankings.push({ id: pid, genre: data.genre, type: data.type, avg, count: data.count, favRate, favCount: data.favCount, modelBreakdown });
      }
      rankings.sort((a, b) => b.avg - a.avg);
      this.kb.promptRankings = rankings;
    },

    get filteredPromptRankings() {
      let list = this.kb.promptRankings;
      if (this.kb.promptFilter) {
        const f = this.kb.promptFilter.toLowerCase();
        list = list.filter(p => p.id.toLowerCase().includes(f) || p.genre.toLowerCase().includes(f) || p.type.toLowerCase().includes(f));
      }
      if (this.kb.promptSort === 'favRate') {
        list = [...list].sort((a, b) => b.favRate - a.favRate);
      } else if (this.kb.promptSort === 'genre') {
        list = [...list].sort((a, b) => a.genre.localeCompare(b.genre) || b.avg - a.avg);
      }
      return list;
    },

    // =========================================================================
    // Export
    // =========================================================================

    exportKBMarkdown() {
      if (!this.kb.matrix) return '';
      const m = this.kb.matrix;
      let md = '# Knowledge Base Export\n\n';
      md += `> Generated: ${new Date().toISOString()}\n\n`;

      // Decision Matrix
      md += '## Model Decision Matrix (by Genre)\n\n';
      md += '| Genre | Best Model | Score | Samples | Fav% |\n|---|---|---|---|---|\n';
      for (const genre of m.genres) {
        const w = this.matrixWinner(genre);
        if (w) {
          md += `| ${genre} | ${w.model} | ${w.avg} | ${w.count} | ${w.favRate}% |\n`;
        }
      }

      // Prompt Rankings (top 20)
      md += '\n## Top Prompts\n\n';
      md += '| # | Prompt | Genre | Type | Avg | Samples | Fav% |\n|---|---|---|---|---|---|---|\n';
      this.kb.promptRankings.slice(0, 20).forEach((p, i) => {
        md += `| ${i + 1} | ${p.id} | ${p.genre} | ${p.type} | ${p.avg} | ${p.count} | ${p.favRate}% |\n`;
      });

      return md;
    },

    copyKBMarkdown() {
      const md = this.exportKBMarkdown();
      navigator.clipboard.writeText(md);
    },

    exportKBJSON() {
      const data = {
        generated_at: new Date().toISOString(),
        matrix: this.kb.matrix,
        prompt_rankings: this.kb.promptRankings,
        recommendation_cache: this.kb.recommendation,
      };
      return JSON.stringify(data, null, 2);
    },

    copyKBJSON() {
      navigator.clipboard.writeText(this.exportKBJSON());
    },
  };
}
