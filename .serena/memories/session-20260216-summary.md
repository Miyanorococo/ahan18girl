# Session 2026-02-16 Summary

## Key Changes
- Gallery: 5-axis → 4-tier rating (★5/♥2/👎-1), carousel lightbox, cross-model grid nav
- AI Scoring: anime-aesthetic ONNX on Lambda (3GB, 1651/1652 scored), auto on zip extract
- **AI score ≠ human rating (inverse correlation)** → AI = defect filter only
- Prompts: v2.4 (dark→bright, negative→positive, +embarrassment, +dynamic tags)
- Top models (human eval 433 images): Nova(★21/120=18%), Animagine(★21/100=21%), Rouwei(★5/58=9%)
- birth type: ★0, 👎53% → remove from prompts
- Tests: fucked_silly(13 models DONE), dynamic(4 models IN PROGRESS)

## Architecture
- Gallery: Alpine.js SPA on S3+CloudFront, Lambda API, Bedrock genre inference
- AI Scorer: anime-aesthetic ONNX (Lambda Layer, 3GB RAM, 900s timeout)
- Batch: AWS Batch + Step Functions (13 models parallel on g6 Spot)
- Prompts: eval-prompts-v2-unified-anime.json (v2.4, 122 prompts)

## Model Selection (Human Eval)
| Model | ★ | ♥ | 👎 | ★Rate | Recommendation |
|-------|---|---|---|-------|----------------|
| Animagine XL 4.0 | 21 | 68 | 11 | 21% | Main candidate B |
| Nova Anime XL | 21 | 93 | 6 | 18% | Main candidate A |
| WAI Branch-Rouwei | 5 | 50 | 3 | 9% | NSFW specialist |
| WAI v11-v16 | 2-5 | 17-34 | 2-4 | 0-6% | On hold |
| Pony/Illustrij/SD1.5 | 0 | 0-1 | 1-3 | 0% | Eliminated |

## Session Extended (2026-02-17 early morning)

### Production
- 3 Books generated: 0216a(JK), 0216b(wife), 0216c(nurse) × 34 scenes × 7 models = 2,142 images
- Book ID system: MMDD+letter (0216a, 0216b...) for unique book identification
- Story template: 33 scenes (cover→date→kiss→sex1→bath→toy→sex2→pregnancy→birth→future+bonus)
- Sex① = surprise/embarrassment, Sex② = addiction/insatiable
- Seeds: random at prompt creation, shared across models
- FeMix config fixed (was wrong sampler/scheduler/clip_skip)

### Gallery Features Added
- Book View: list (cover thumb + metadata) → detail (page nav + model/seed switch)
- Book Editor: timeline, candidate grid, auto-select, PDF/ZIP export
- Drag & drop: candidate→slot, candidate→preview, slot↔slot reorder
- Batch Rate: Shift+click multi-select → bulk rating
- Smart Suggest: ★ on model → suggest for unselected pages
- Before/After: edit prompts → flag → regenerate from UI (in progress)
- gallery-new: full Alpine.js migration with new sidebar/Material Icons design

### Prompt Improvements
- fucked_silly: orgasm→ahegao, sex→fucked_silly, ejac→cross-eyed+dazed
- dynamic: twisted_torso for from_behind, leaning_forward for sensitive
- Animagine: strip_tags 33 (lighting/angle/skin), wind kept
- Futanari: penis→enlarged clitoris/clitoris hypertrophy
- Random seeds per book generation

## Session 2026-02-18 Updates

### Book Editor Enhancements
- Drag & drop: candidate→slot (swap), candidate→insert zone (+button), slot↔slot reorder
- Insert zones: hidden by default, expand with + icon during drag
- Shelf: always visible with drop zone placeholder
- Undo/Redo: Ctrl+Z/Y, 50-step history
- Per-model generation tabs (R0/R1/R2) for regen candidates
- Rating overlay on candidate thumbnails (★/♥/👎 semi-transparent)
- Page numbers on timeline
- Delete key removes page to shelf
- View/Editor toggle: CSS-only (.book-editor-active class)
- PDF export: no background/margins, jsPDF 2.5.1

### Bug Fixes
- lightbox.js: `entry` undefined → `updated`
- app.js: `const stored` → `let stored` (R2→R1 migration)
- favicon.ico added (fixes 502)
- Orphaned CSS removed (334 lines)
- HTML unclosed tags fixed (multiple instances)
- effectAllowed/dropEffect unified to 'all'
- R2→R1 S3 rename + localStorage migration

### Prompt File Conflict Resolution
- Each book uses dedicated S3 key: eval-scripts/eval-prompts-{bookId}.json
- Regen API no longer overwrites shared eval-prompts.json
- Step Functions: promptsFile parameter added (pending Docker rebuild for full support)
- Current workaround: ensure eval-prompts.json is correct before batch start

### Book 0218a (Blue Hair)
- Character: 青髪ロング サイドブレイド、琥珀色の目、巨乳、20歳日本人
- Style: 朝のまどろみ、白Tシャツ、コージーベッドルーム
- Seeds: [974592, 427904, 556469] (random)
- Status: generating (88/238)

### Generation Naming
- R0 = original, R1 = first regen, R2 = second regen
- S3: no-prefix=R0, _R1_=R1, _R2_=R2 (consistent)

## Next Actions
1. Complete 0218a generation + scoring + index rebuild
2. Review all 4 books, select best for first publication
3. PDF export → text/dialogue → DLSite upload
4. Docker rebuild with PROMPTS_FILE support for true parallel batches