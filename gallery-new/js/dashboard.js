/**
 * Dashboard mixin for Alpine.js gallery component.
 * Provides aggregated model statistics, Chart.js radar/bar visualizations,
 * model-level comments and verdicts, and Markdown/JSON export.
 */
function dashboardMixin() {
  return {
    dashboard: {
      modelStats: [],      // Per-model aggregated stats
      summary: null,       // Overall summary stats
      favorites: null,     // Favorites analysis
      heatmap: null,       // model × genre score matrix
      insights: [],        // Auto-detected patterns
      _expandedModel: null, // currently expanded model in ranking
      loading: false,
    },

    /**
     * Initialize dashboard. Aggregates ratings by model,
     * computes per-axis averages, and renders charts.
     */
    initDashboard() {
      this.dashboard.loading = true;
      this._computeDashboardStats();
      this._computeFavoritesAnalysis();
      this._computeHeatmap();
      this._computeInsights();
      this.dashboard.loading = false;
    },

    /**
     * Aggregate image ratings by model using experiment data.
     * For each model, compute: total images, rated count,
     * per-axis average scores, and overall average.
     */
    _computeDashboardStats() {
      // Count total images and experiments per model
      const modelImageCounts = {};
      for (const exp of this.experiments) {
        const model = exp.model;
        if (!model) continue;
        if (!modelImageCounts[model]) {
          modelImageCounts[model] = { total: 0, experiments: 0 };
        }
        modelImageCounts[model].total += exp.image_count || 0;
        modelImageCounts[model].experiments += 1;
      }

      // Map experiment IDs to models for O(1) lookup
      const expModelMap = {};
      for (const exp of this.experiments) {
        if (exp.id && exp.model) {
          expModelMap[exp.id] = exp.model;
        }
      }

      // Aggregate 4-tier ratings per model: ★(5) / ♥(2) / 👎(-1) / unrated
      const modelTiers = {};
      const modelCommentCount = {};

      for (const [key, entry] of Object.entries(this.ratings.images || {})) {
        if (!entry?.scores) continue;
        const overall = entry.scores.overall;
        if (overall === undefined || overall === null) continue;

        const match = key.match(/gallery\/experiments\/(.+?)\/(full|thumb)\//);
        const model = match ? expModelMap[match[1]] : null;
        if (!model) continue;

        if (!modelTiers[model]) {
          modelTiers[model] = { star: 0, heart: 0, bad: 0, total: 0 };
          modelCommentCount[model] = 0;
        }
        modelTiers[model].total++;
        if (overall >= 5) modelTiers[model].star++;
        else if (overall >= 2) modelTiers[model].heart++;
        else if (overall < 0) modelTiers[model].bad++;
        if (entry.comment) modelCommentCount[model]++;
      }

      // Build stats array
      const stats = [];
      const allModels = [...new Set([
        ...Object.keys(modelImageCounts),
        ...Object.keys(modelTiers),
      ])].sort();

      for (const model of allModels) {
        const counts = modelImageCounts[model] || { total: 0, experiments: 0 };
        const tiers = modelTiers[model] || { star: 0, heart: 0, bad: 0, total: 0 };
        const modelData = this.getModelData(model);

        // Score: weighted average (★=5, ♥=2, 👎=-1)
        const rated = tiers.star + tiers.heart + tiers.bad;
        const weightedSum = tiers.star * 5 + tiers.heart * 2 + tiers.bad * -1;
        const overallAvg = rated > 0 ? Math.round(weightedSum / rated * 10) / 10 : 0;

        stats.push({
          model,
          displayName: this.displayModelName(model),
          experiments: counts.experiments,
          imageCount: counts.total,
          ratedCount: rated,
          commentedCount: modelCommentCount[model] || 0,
          tiers,
          overallAvg,
          comment: modelData.comment,
          verdict: modelData.verdict,
        });
      }

      // Sort by overall average descending
      stats.sort((a, b) => b.overallAvg - a.overallAvg);

      // Summary
      const totalRated = Object.values(this.ratings.images || {})
        .filter(e => e?.scores && Object.values(e.scores).some(v => v > 0))
        .length;
      const totalCommented = Object.values(this.ratings.images || {})
        .filter(e => e?.comment)
        .length;
      const totalImages = this.experiments.reduce((s, e) => s + (e.image_count || 0), 0);

      this.dashboard.modelStats = stats;
      this.dashboard.summary = {
        totalModels: allModels.length,
        totalExperiments: this.experiments.length,
        totalImages,
        totalRated,
        totalCommented,
        ratingProgress: totalImages > 0 ? Math.round(totalRated / totalImages * 100) : 0,
      };
    },

    /**
     * Extract experiment ID from a rating key using regex (O(1) lookup).
     * Rating keys look like: /gallery/experiments/{exp_id}/(full|thumb)/filename.png
     */
    _resolveRatingKey(key, expMap) {
      const match = key.match(/gallery\/experiments\/(.+?)\/(full|thumb)\//);
      if (match) return expMap[match[1]] || null;
      return null;
    },

    /**
     * Analyze favorited images: breakdown by model, prompt, seed.
     */
    _computeFavoritesAnalysis() {
      const expMap = {};
      const totalByModel = {};
      const totalByPrompt = {};
      for (const exp of this.experiments) {
        if (exp.id) expMap[exp.id] = exp;
        const m = exp.model || 'unknown';
        const p = exp.prompt_summary || exp.id;
        totalByModel[m] = (totalByModel[m] || 0) + (exp.image_count || 0);
        totalByPrompt[p] = (totalByPrompt[p] || 0) + (exp.image_count || 0);
      }

      const byModel = {};
      const byPrompt = {};
      const bySeed = {};
      const favImages = [];

      for (const [key, entry] of Object.entries(this.ratings.images || {})) {
        if (!entry?.favorited) continue;

        const exp = this._resolveRatingKey(key, expMap);
        const model = exp?.model || 'unknown';
        const prompt = exp?.prompt_summary || 'unknown';
        const seedMatch = key.match(/seed(\d+)/);
        const seed = seedMatch ? seedMatch[1] : 'unknown';

        byModel[model] = (byModel[model] || 0) + 1;
        byPrompt[prompt] = (byPrompt[prompt] || 0) + 1;
        bySeed[seed] = (bySeed[seed] || 0) + 1;

        favImages.push({
          key, model, prompt, seed,
          scores: entry.scores || {},
          overallAvg: entry.scores?.overall || 0,
        });
      }

      const sortWithTotal = (counts, totals) =>
        Object.entries(counts)
          .map(([k, v]) => [k, v, totals[k] || 0])
          .sort((a, b) => b[1] - a[1]);

      this.dashboard.favorites = {
        total: favImages.length,
        totalImages: this.experiments.reduce((s, e) => s + (e.image_count || 0), 0),
        byModel: sortWithTotal(byModel, totalByModel),
        byPrompt: sortWithTotal(byPrompt, totalByPrompt),
        bySeed: Object.entries(bySeed).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v, 0]),
        topImages: favImages.sort((a, b) => b.overallAvg - a.overallAvg).slice(0, 20),
      };
    },

    /**
     * Build model × genre heatmap using experiment-level AI scores (no rating key loops).
     */
    _computeHeatmap() {
      const heatData = {};
      const genres = new Set();

      for (const exp of this.experiments) {
        const model = exp.model;
        const genre = (exp.genre || 'other').toLowerCase();
        const score = exp.aesthetic_avg;
        if (!model || !score) continue;

        genres.add(genre);
        if (!heatData[model]) heatData[model] = {};
        if (!heatData[model][genre]) heatData[model][genre] = { sum: 0, count: 0 };
        heatData[model][genre].sum += score * 5; // normalize 0-1 to 0-5 scale
        heatData[model][genre].count++;
      }

      const genreList = [...genres].sort();
      const models = Object.keys(heatData).sort();

      const rows = models.map(model => {
        const cells = genreList.map(genre => {
          const d = heatData[model]?.[genre];
          if (!d) return { score: null, count: 0 };
          return { score: Math.round(d.sum / d.count * 10) / 10, count: d.count };
        });
        const scored = cells.filter(c => c.score !== null);
        const avg = scored.length > 0 ? Math.round(scored.reduce((s, c) => s + c.score, 0) / scored.length * 10) / 10 : null;
        return { model, displayName: this.displayModelName(model), cells, avg };
      });
      rows.sort((a, b) => (b.avg || 0) - (a.avg || 0));

      this.dashboard.heatmap = { genres: genreList, rows };
    },

    /**
     * Auto-detect patterns from ratings data.
     */
    _computeInsights() {
      const insights = [];
      const stats = this.dashboard.modelStats;
      const hm = this.dashboard.heatmap;

      if (stats.length < 2) {
        this.dashboard.insights = [];
        return;
      }

      // 1. Overall leader
      const top = stats[0];
      if (top && top.overallAvg > 0) {
        const lead = stats.length > 1
          ? (top.overallAvg - stats[1].overallAvg).toFixed(1)
          : '0';
        insights.push({
          type: 'leader',
          text: `${top.model} が総合トップ (${top.overallAvg.toFixed(1)})。2位との差: +${lead}`,
        });
      }

      // 2. Genre specialists — find models that are #1 in specific genres
      if (hm && hm.genres.length > 0) {
        const genreWinners = {};
        for (const genre of hm.genres) {
          let best = null, bestScore = 0;
          for (const row of hm.rows) {
            const gIdx = hm.genres.indexOf(genre);
            const cell = row.cells[gIdx];
            if (cell && cell.score > bestScore) {
              bestScore = cell.score;
              best = row.model;
            }
          }
          if (best) genreWinners[genre] = { model: best, score: bestScore };
        }
        // Group genres by winning model
        const modelGenres = {};
        for (const [genre, w] of Object.entries(genreWinners)) {
          if (!modelGenres[w.model]) modelGenres[w.model] = [];
          modelGenres[w.model].push(genre);
        }
        for (const [model, gens] of Object.entries(modelGenres)) {
          if (gens.length >= 2) {
            insights.push({
              type: 'specialist',
              text: `${model} は ${gens.join(', ')} で1位`,
            });
          }
        }
      }

      // 3. Most favorited model
      const favs = this.dashboard.favorites;
      if (favs && favs.byModel.length > 0) {
        const [topFavModel, topFavCount, topFavTotal] = favs.byModel[0];
        const rate = topFavTotal > 0 ? Math.round(topFavCount / topFavTotal * 100) : 0;
        insights.push({
          type: 'favorite',
          text: `♥ ${topFavModel} が最多お気に入り: ${topFavCount}枚 (${rate}%)`,
        });
      }

      // 4. Tier highlights — models with high ★ or ♥ ratios
      for (const stat of stats.slice(0, 5)) {
        const t = stat.tiers;
        if (!t || t.total === 0) continue;
        const starRate = Math.round(t.star / t.total * 100);
        if (starRate >= 40 && t.star >= 3) {
          insights.push({
            type: 'strength',
            text: `★ ${stat.displayName}: ★率${starRate}% (${t.star}/${t.total}枚)`,
          });
        }
      }

      // 5. Consistency check — models with low variance across genres
      if (hm && hm.genres.length >= 3) {
        for (const row of hm.rows) {
          const scores = row.cells.filter(c => c.score !== null).map(c => c.score);
          if (scores.length < 3) continue;
          const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
          const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
          if (variance < 0.15 && mean >= 3.5) {
            insights.push({
              type: 'consistent',
              text: `${row.model}: 全ジャンル安定 (平均${mean.toFixed(1)}, 分散${variance.toFixed(2)})`,
            });
          }
        }
      }

      this.dashboard.insights = insights.slice(0, 10);
    },

    /**
     * Save model comment (debounced from textarea).
     */
    saveDashboardModelComment(model, comment) {
      this.setModelData(model, { comment });
      const stat = this.dashboard.modelStats.find(s => s.model === model);
      if (stat) stat.comment = comment;
    },

    /**
     * Set model verdict (adopt/hold/reject). Toggles off if same.
     */
    setDashboardVerdict(model, verdict) {
      const stat = this.dashboard.modelStats.find(s => s.model === model);
      if (!stat) return;
      const newVerdict = stat.verdict === verdict ? '' : verdict;
      this.setModelData(model, { verdict: newVerdict });
      stat.verdict = newVerdict;
    },

    /**
     * Export as Markdown. Triggers file download.
     */
    exportMarkdown() {
      const content = this._buildExportMarkdown();
      this._downloadFile(content, 'model-evaluation.md', 'text/markdown');
    },

    /**
     * Export as JSON. Triggers file download.
     */
    exportJSON() {
      const content = this._buildExportJSON();
      this._downloadFile(content, 'model-evaluation.json', 'application/json');
    },

    /**
     * Trigger a browser file download.
     */
    _downloadFile(content, filename, mime) {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },

    /**
     * Build Markdown export string.
     */
    _buildExportMarkdown() {
      const stats = this.dashboard.modelStats;
      const summary = this.dashboard.summary;
      const lines = [];

      lines.push('# Model Evaluation Report');
      lines.push('');
      lines.push(`Generated: ${new Date().toISOString().slice(0, 10)}`);
      lines.push('');

      // Summary
      lines.push('## Summary');
      lines.push('');
      lines.push('| Metric | Value |');
      lines.push('|--------|-------|');
      lines.push(`| Models | ${summary.totalModels} |`);
      lines.push(`| Experiments | ${summary.totalExperiments} |`);
      lines.push(`| Total images | ${summary.totalImages} |`);
      lines.push(`| Rated images | ${summary.totalRated} (${summary.ratingProgress}%) |`);
      lines.push(`| Commented | ${summary.totalCommented} |`);
      lines.push('');

      // Rankings table
      lines.push('## Model Rankings');
      lines.push('');
      lines.push('| Rank | Model | ★ | ♥ | 👎 | Avg | Verdict |');
      lines.push('|------|-------|---|---|---|-----|---------|');
      stats.forEach((s, i) => {
        const t = s.tiers || { star: 0, heart: 0, bad: 0 };
        const verdict = s.verdict ? s.verdict.toUpperCase() : '-';
        lines.push(`| ${i + 1} | ${s.model} | ${t.star} | ${t.heart} | ${t.bad} | ${s.overallAvg.toFixed(1)} | ${verdict} |`);
      });
      lines.push('');

      // Model details
      lines.push('## Model Details');
      lines.push('');
      for (const s of stats) {
        lines.push(`### ${s.model}`);
        lines.push('');
        lines.push(`- Experiments: ${s.experiments}`);
        lines.push(`- Images: ${s.imageCount} total, ${s.ratedCount} rated`);
        lines.push(`- Overall: **${s.overallAvg.toFixed(1)}** / 5`);
        if (s.verdict) lines.push(`- Verdict: **${s.verdict.toUpperCase()}**`);
        if (s.comment) {
          lines.push('');
          lines.push(`> ${s.comment.replace(/\n/g, '\n> ')}`);
        }
        lines.push('');
      }

      // Insights
      const ins = this.dashboard.insights;
      if (ins && ins.length > 0) {
        lines.push('## Insights');
        lines.push('');
        for (const i of ins) {
          lines.push(`- ${i.text}`);
        }
        lines.push('');
      }

      // Heatmap
      const hm = this.dashboard.heatmap;
      if (hm && hm.genres.length > 0 && hm.rows.length > 0) {
        lines.push('## Model × Genre Heatmap');
        lines.push('');
        lines.push('| Model | ' + hm.genres.join(' | ') + ' |');
        lines.push('|-------|' + hm.genres.map(() => '---').join('|') + '|');
        for (const row of hm.rows) {
          const cells = row.cells.map(c => c.score != null ? c.score.toFixed(1) : '-');
          lines.push(`| ${row.model} | ${cells.join(' | ')} |`);
        }
        lines.push('');
      }

      // Favorites analysis
      const favs = this.dashboard.favorites;
      if (favs && favs.total > 0) {
        lines.push('## Favorites Analysis');
        lines.push('');
        lines.push(`Total favorited: **${favs.total}** images`);
        lines.push('');
        lines.push('### By Model');
        lines.push('| Model | Count |');
        lines.push('|-------|-------|');
        for (const [model, count] of favs.byModel) {
          lines.push(`| ${model} | ${count} |`);
        }
        lines.push('');
        lines.push('### By Prompt');
        lines.push('| Prompt | Count |');
        lines.push('|--------|-------|');
        for (const [prompt, count] of favs.byPrompt) {
          lines.push(`| ${prompt} | ${count} |`);
        }
        lines.push('');
      }

      return lines.join('\n');
    },

    /**
     * Build JSON export string.
     */
    _buildExportJSON() {
      const stats = this.dashboard.modelStats;
      const summary = this.dashboard.summary;
      const exportData = {
        generated: new Date().toISOString(),
        summary: { ...summary },
        models: stats.map(s => ({
          model: s.model,
          experiments: s.experiments,
          imageCount: s.imageCount,
          ratedCount: s.ratedCount,
          commentedCount: s.commentedCount,
          tiers: { ...s.tiers },
          overallAvg: s.overallAvg,
          verdict: s.verdict || null,
          comment: s.comment || null,
        })),
      };

      return JSON.stringify(exportData, null, 2);
    },
  };
}
