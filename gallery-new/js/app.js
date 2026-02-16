class App {
    constructor() {
        this.state = {
            currentView: 'dashboard',
            experiments: [],
            filteredExperiments: [],
            models: new Set(),
            genres: new Set(),
            filters: {
                search: '',
                model: '',
                genre: ''
            },
            currentExperiment: null
        };

        this.els = {
            navItems: document.querySelectorAll('.nav-item'),
            views: document.querySelectorAll('.view'),
            viewTitle: document.querySelector('.current-view-title'),
            globalSearch: document.getElementById('globalSearch'),
            filterModel: document.getElementById('filter-model'),
            filterGenre: document.getElementById('filter-genre'),
            grid: document.getElementById('experiments-grid'),
            dashboardRecent: document.getElementById('dashboard-recent-grid'),
            kpiTotalExp: document.getElementById('kpi-total-exp'),
            kpiTotalImg: document.getElementById('kpi-total-img'),
            kpiFav: document.getElementById('kpi-fav'),
            detailView: document.getElementById('view-detail'),
            detailTitle: document.getElementById('detail-title'),
            detailModel: document.getElementById('detail-model'),
            detailPrompt: document.getElementById('detail-prompt'),
            detailGallery: document.getElementById('detail-gallery'),
            themeToggle: document.getElementById('themeToggle')
        };

        this.init();
    }

    async init() {
        this.bindEvents();
        await this.loadData();
        this.render();
    }

    bindEvents() {
        // Navigation
        this.els.navItems.forEach(item => {
            item.addEventListener('click', (e) => {
                const view = e.currentTarget.dataset.view;
                this.navigate(view);
            });
        });

        // Search
        this.els.globalSearch.addEventListener('input', (e) => {
            this.state.filters.search = e.target.value.toLowerCase();
            this.applyFilters();
        });

        // Filters
        this.els.filterModel.addEventListener('change', (e) => {
            this.state.filters.model = e.target.value;
            this.applyFilters();
        });

        // Theme Toggle
        this.els.themeToggle.addEventListener('click', () => {
            // Toggle theme logic if needed, currently just dark mode
            document.body.classList.toggle('light-theme');
        });

        // Back button in detail view
        document.querySelector('.back-btn').addEventListener('click', () => {
            this.navigate('experiments');
        });
    }

    async loadData() {
        try {
            const data = await GalleryAPI.getExperiments();
            this.state.experiments = data.sort((a, b) => new Date(b.created_at || b.date) - new Date(a.created_at || a.date));
            this.processData();
            this.applyFilters();
        } catch (error) {
            console.error('Failed to load data', error);
        }
    }

    processData() {
        this.state.models.clear();
        this.state.genres.clear();

        let totalImages = 0;

        this.state.experiments.forEach(exp => {
            if (exp.model) this.state.models.add(exp.model);
            if (exp.genre) this.state.genres.add(exp.genre);
            totalImages += (exp.image_count || 0);
        });

        // Update KPIs
        this.els.kpiTotalExp.textContent = this.state.experiments.length;
        this.els.kpiTotalImg.textContent = totalImages;

        // Populate Selects
        this.state.models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            this.els.filterModel.appendChild(opt);
        });
    }

    applyFilters() {
        const { search, model, genre } = this.state.filters;
        this.state.filteredExperiments = this.state.experiments.filter(exp => {
            const matchSearch = (exp.prompt_summary || exp.id).toLowerCase().includes(search);
            const matchModel = !model || exp.model === model;
            return matchSearch && matchModel;
        });

        this.renderExperimentGrid();
        this.renderDashboard();
    }

    navigate(viewName) {
        this.state.currentView = viewName;

        // Update Sidebar
        this.els.navItems.forEach(item => {
            item.classList.toggle('active', item.dataset.view === viewName);
        });

        // Update View Visibility
        this.els.views.forEach(view => {
            view.classList.remove('active');
            if (view.id === `view-${viewName}`) {
                view.classList.add('active');
            }
        });

        // Special case for detail view (it's not in nav)
        if (viewName === 'detail') {
            this.els.detailView.classList.add('active');
        }

        this.els.viewTitle.textContent = viewName.charAt(0).toUpperCase() + viewName.slice(1);
    }

    render() {
        this.renderDashboard();
        this.renderExperimentGrid();
    }

    renderDashboard() {
        const recent = this.state.experiments.slice(0, 8);
        this.els.dashboardRecent.innerHTML = recent.map(exp => this.createCardHTML(exp)).join('');

        // Add click events
        this.els.dashboardRecent.querySelectorAll('.experiment-card').forEach(card => {
            card.addEventListener('click', () => this.openDetail(card.dataset.id));
        });
    }

    renderExperimentGrid() {
        const exps = this.state.filteredExperiments; // Pagination could be added here
        this.els.grid.innerHTML = exps.map(exp => this.createCardHTML(exp)).join('');

        // Add click events
        this.els.grid.querySelectorAll('.experiment-card').forEach(card => {
            card.addEventListener('click', () => this.openDetail(card.dataset.id));
        });
    }

    createCardHTML(exp) {
        // Fallback for thumbnail
        const thumb = exp.thumbnail || (exp.images && exp.images[0] ? exp.images[0].thumb_url : '');

        return `
            <div class="experiment-card" data-id="${exp.id}">
                <div class="card-thumb">
                    ${thumb ? `<img src="${thumb}" loading="lazy" alt="${exp.id}">` : ''}
                </div>
                <div class="card-info">
                    <div class="card-title" title="${exp.prompt_summary || exp.id}">${exp.prompt_summary || exp.id}</div>
                    <div class="card-meta">
                        <span class="badge">${exp.model || 'Unknown'}</span>
                        <span class="badge">${exp.image_count || 0} imgs</span>
                    </div>
                </div>
            </div>
        `;
    }

    async openDetail(id) {
        const exp = await GalleryAPI.getExperiment(id); // Fetch full details
        this.state.currentExperiment = exp;

        this.els.detailTitle.textContent = exp.prompt_summary || exp.id;
        this.els.detailModel.textContent = exp.metadata?.model?.checkpoint || exp.model || 'Unknown';
        this.els.detailPrompt.textContent = exp.metadata?.prompt?.positive || 'No prompt data';

        this.els.detailGallery.innerHTML = (exp.images || []).map(img => `
            <div class="detail-image">
                <img src="${img.thumb_url}" loading="lazy" data-full="${img.full_url}">
            </div>
        `).join('');

        this.navigate('detail');
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});
