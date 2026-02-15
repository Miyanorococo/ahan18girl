/**
 * Dashboard mixin for Alpine.js gallery component.
 * Provides aggregated model statistics, Chart.js radar/bar visualizations,
 * model-level comments and verdicts, and Markdown/JSON export.
 */
function dashboardMixin() {
  // Chart.js instance references for cleanup
  let _radarChart = null;
  let _barChart = null;

  return {
    dashboard: {
      modelStats: [],      // Per-model aggregated stats
      summary: null,       // Overall summary stats
      loading: false,
      chartReady: false,
    },

    /**
     * Initialize dashboard. Aggregates ratings by model,
     * computes per-axis averages, and renders charts.
     */
    initDashboard() {
      this.dashboard.loading = true;
      this._computeDashboardStats();
      this.dashboard.loading = false;
      // Render charts after DOM update
      this.$nextTick(() => this._renderCharts());
    },

    /**
     * Aggregate image ratings by model using experiment data.
     * For each model, compute: total images, rated count,
     * per-axis average scores, and overall average.
     */
    _computeDashboardStats() {
      const axes = this.RATING_AXES;

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

      // Map rating keys to models via experiment id substring matching.
      // Rating keys are full_url / thumb_url / name, which typically
      // contain the experiment id in their path.
      const expModelMap = {};
      for (const exp of this.experiments) {
        if (exp.id && exp.model) {
          expModelMap[exp.id] = exp.model;
        }
      }

      // Aggregate scores per model
      const modelScores = {}; // model -> { [axis]: { sum, count } }
      const modelRatedCount = {};
      const modelCommentCount = {};

      for (const [key, entry] of Object.entries(this.ratings.images || {})) {
        if (!entry?.scores) continue;
        const hasScore = Object.values(entry.scores).some(v => v > 0);
        if (!hasScore) continue;

        // Identify model from rating key by matching experiment id
        let model = null;
        for (const [expId, expModel] of Object.entries(expModelMap)) {
          if (key.includes(expId)) {
            model = expModel;
            break;
          }
        }
        if (!model) continue;

        if (!modelScores[model]) {
          modelScores[model] = {};
          modelRatedCount[model] = 0;
          modelCommentCount[model] = 0;
        }
        modelRatedCount[model]++;
        if (entry.comment) modelCommentCount[model]++;

        for (const axis of axes) {
          const score = entry.scores[axis.key];
          if (score && score > 0) {
            if (!modelScores[model][axis.key]) {
              modelScores[model][axis.key] = { sum: 0, count: 0 };
            }
            modelScores[model][axis.key].sum += score;
            modelScores[model][axis.key].count += 1;
          }
        }
      }

      // Build stats array
      const stats = [];
      const allModels = [...new Set([
        ...Object.keys(modelImageCounts),
        ...Object.keys(modelScores),
      ])].sort();

      for (const model of allModels) {
        const counts = modelImageCounts[model] || { total: 0, experiments: 0 };
        const scores = modelScores[model] || {};
        const avgScores = {};
        let totalScore = 0;
        let totalAxes = 0;

        for (const axis of axes) {
          const data = scores[axis.key];
          if (data && data.count > 0) {
            const avg = Math.round(data.sum / data.count * 10) / 10;
            avgScores[axis.key] = avg;
            totalScore += avg;
            totalAxes++;
          } else {
            avgScores[axis.key] = null;
          }
        }

        const modelData = this.getModelData(model);

        stats.push({
          model,
          displayName: this.displayModelName(model),
          experiments: counts.experiments,
          imageCount: counts.total,
          ratedCount: modelRatedCount[model] || 0,
          commentedCount: modelCommentCount[model] || 0,
          avgScores,
          overallAvg: totalAxes > 0 ? Math.round(totalScore / totalAxes * 10) / 10 : 0,
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
     * Render Chart.js radar and bar charts.
     * Charts are created/updated in existing canvas elements.
     */
    _renderCharts() {
      if (typeof Chart === 'undefined') {
        this.dashboard.chartReady = false;
        return;
      }
      this.dashboard.chartReady = true;

      const stats = this.dashboard.modelStats.filter(s => s.overallAvg > 0);
      if (stats.length === 0) return;

      const axes = this.RATING_AXES;
      const labels = axes.map(a => a.short);

      // Color palette matching the app's dark theme
      const colors = [
        'rgba(233, 69, 96, 0.7)',
        'rgba(83, 52, 131, 0.7)',
        'rgba(0, 188, 212, 0.7)',
        'rgba(255, 193, 7, 0.7)',
        'rgba(76, 175, 80, 0.7)',
        'rgba(255, 87, 34, 0.7)',
        'rgba(156, 39, 176, 0.7)',
        'rgba(3, 169, 244, 0.7)',
        'rgba(255, 152, 0, 0.7)',
        'rgba(139, 195, 74, 0.7)',
      ];
      const bgColors = colors.map(c => c.replace('0.7', '0.15'));

      // --- Radar chart ---
      const radarCanvas = document.getElementById('radar-chart');
      if (radarCanvas) {
        if (_radarChart) _radarChart.destroy();

        const datasets = stats.slice(0, 8).map((s, i) => ({
          label: s.displayName,
          data: axes.map(a => s.avgScores[a.key] || 0),
          borderColor: colors[i % colors.length],
          backgroundColor: bgColors[i % bgColors.length],
          pointBackgroundColor: colors[i % colors.length],
          pointRadius: 3,
          borderWidth: 2,
        }));

        _radarChart = new Chart(radarCanvas, {
          type: 'radar',
          data: { labels, datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              r: {
                min: 0,
                max: 5,
                ticks: {
                  stepSize: 1,
                  color: '#666',
                  backdropColor: 'transparent',
                },
                grid: { color: 'rgba(255,255,255,0.06)' },
                angleLines: { color: 'rgba(255,255,255,0.06)' },
                pointLabels: {
                  color: '#aaa',
                  font: { size: 12 },
                },
              },
            },
            plugins: {
              legend: {
                labels: { color: '#aaa', boxWidth: 12, font: { size: 11 } },
                position: 'bottom',
              },
            },
          },
        });
      }

      // --- Bar chart (overall averages) ---
      const barCanvas = document.getElementById('bar-chart');
      if (barCanvas) {
        if (_barChart) _barChart.destroy();

        const barData = stats.slice(0, 12);

        _barChart = new Chart(barCanvas, {
          type: 'bar',
          data: {
            labels: barData.map(s => s.displayName),
            datasets: [{
              label: 'Overall Avg',
              data: barData.map(s => s.overallAvg),
              backgroundColor: barData.map((_, i) => colors[i % colors.length]),
              borderRadius: 4,
              barThickness: 28,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            scales: {
              x: {
                min: 0,
                max: 5,
                ticks: { color: '#666', stepSize: 1 },
                grid: { color: 'rgba(255,255,255,0.04)' },
              },
              y: {
                ticks: { color: '#aaa', font: { size: 11 } },
                grid: { display: false },
              },
            },
            plugins: {
              legend: { display: false },
            },
          },
        });
      }
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
      const axes = this.RATING_AXES;
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
      const axisHeaders = axes.map(a => a.short).join(' | ');
      lines.push(`| Rank | Model | ${axisHeaders} | Avg | Verdict |`);
      lines.push(`|------|-------|${axes.map(() => '---').join('|')}|-----|---------|`);
      stats.forEach((s, i) => {
        const axisVals = axes.map(a =>
          s.avgScores[a.key] != null ? s.avgScores[a.key].toFixed(1) : '-'
        ).join(' | ');
        const verdict = s.verdict ? s.verdict.toUpperCase() : '-';
        lines.push(`| ${i + 1} | ${s.model} | ${axisVals} | ${s.overallAvg.toFixed(1)} | ${verdict} |`);
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

      return lines.join('\n');
    },

    /**
     * Build JSON export string.
     */
    _buildExportJSON() {
      const stats = this.dashboard.modelStats;
      const summary = this.dashboard.summary;
      const axes = this.RATING_AXES;

      const exportData = {
        generated: new Date().toISOString(),
        summary: { ...summary },
        models: stats.map(s => ({
          model: s.model,
          experiments: s.experiments,
          imageCount: s.imageCount,
          ratedCount: s.ratedCount,
          commentedCount: s.commentedCount,
          scores: { ...s.avgScores },
          overallAvg: s.overallAvg,
          verdict: s.verdict || null,
          comment: s.comment || null,
        })),
        axes: axes.map(a => ({ key: a.key, label: a.label })),
      };

      return JSON.stringify(exportData, null, 2);
    },
  };
}
