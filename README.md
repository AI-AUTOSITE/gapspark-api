# GapSpark — Marketing & Legal Site

Next.js 14 marketing site, privacy policy, and terms of service for [GapSpark](https://github.com/ai-autosite/gapspark-ios).

**Live:** https://gapspark.defrust.com

## Pages

- `/` → Landing page
- `/privacy` → Privacy policy
- `/terms` → Terms of service

## Tech stack

- **Next.js 14.2.3** (App Router) — stable, no experimental features
- **React 18.2.0** — stable
- **TypeScript 5.3** — relaxed settings (strict: false)
- **Tailwind CSS 3.4** — utility-first styling
- No turbopack, no React 19, no Tailwind v4

## Local development

```bash
npm install
npm run dev
# → http://localhost:3000
```

## Adding assets

### App icon
Place `icon.png` (1024×1024) in `public/`:
```
public/icon.png
```
Used in: navigation bar, hero section, Open Graph preview, favicon, footer.

### Screenshots
Screenshots live in `public/screenshots/` as web-optimized **WebP** (resized to
640px wide; App Store PNGs are ~2.2 MB total, the WebP set is ~250 KB):

```
public/screenshots/hero.webp        # Hero phone mockup (cropped, frameless Discover screen)
public/screenshots/discover.webp    # Discover tab
public/screenshots/painpoint.webp   # Pain point detail
public/screenshots/deepdive.webp    # Deep Dive analysis
public/screenshots/concept.webp     # App concept
public/screenshots/ideas.webp       # Saved ideas
public/screenshots/search.webp      # Unified search
```

**Note on framing:**
- The 6 grid screenshots (`Screenshots.tsx`) already include a device frame, so the
  component shows them directly (no extra frame) with rounded corners + shadow.
- The hero (`Hero.tsx`) draws its own device frame, so `hero.webp` is the **app screen
  only** (frame/background cropped out) so it sits cleanly inside that frame.

If an image is missing, a placeholder caption displays in its place — no layout breakage.

## Structure

```
gapspark-web/
├── app/
│   ├── layout.tsx          # Root layout with metadata
│   ├── page.tsx            # Landing page
│   ├── globals.css         # Tailwind + CSS variables
│   ├── privacy/page.tsx    # Privacy policy
│   └── terms/page.tsx      # Terms of service
├── components/
│   ├── Nav.tsx             # Sticky blur nav
│   ├── Hero.tsx            # Hero section with phone mockup
│   ├── ProblemStatement.tsx
│   ├── Features.tsx        # 6 feature cards
│   ├── Screenshots.tsx     # 6-phone screenshot grid
│   ├── HowItWorks.tsx      # 4 numbered steps
│   ├── TechStack.tsx       # 4-layer AI architecture
│   ├── CTA.tsx             # Final call-to-action
│   └── Footer.tsx          # Footer with links
├── public/
│   ├── icon.png            # App icon
│   └── screenshots/        # Marketing screenshots (.webp)
├── package.json
├── tsconfig.json
├── tailwind.config.js
├── postcss.config.js
├── next.config.js
└── README.md
```

## Deployment (Vercel)

The site is connected to Vercel via GitHub. Every push to `main` auto-deploys;
pull requests get preview URLs automatically.

### Custom domain

In Vercel project → Settings → Domains:
- `gapspark.defrust.com` (CNAME)

## Design notes

- Apple-inspired aesthetic with system fonts (SF Pro)
- Responsive grid — phones, tablets, desktop
- Auto dark/light mode via `prefers-color-scheme`
- No third-party trackers, analytics, or fonts
- Privacy-first by default

## License

MIT
