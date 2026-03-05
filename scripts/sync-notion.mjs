/**
 * Notion → MDX Sync Script for AI Hive Docs
 *
 * Queries the Notion database, converts pages to MDX,
 * downloads images locally, and auto-generates the docs.json navigation.
 *
 * Usage: node scripts/sync-notion.mjs
 */

import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import https from "https";
import http from "http";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

// ─── Config (Cấu hình) ───────────────────────────────────────────────
// Lấy các biến cấu hình từ file .env
const NOTION_TOKEN = process.env.NOTION_TOKEN; // Token kết nối API của Notion
const DATABASE_ID = process.env.NOTION_DATABASE_ID; // ID của database tài liệu trên Notion
const DEFAULT_LANG = process.env.DEFAULT_LANG || "vi"; // Ngôn ngữ gốc (Lưu tại thư mục gốc của dự án)
const SUPPORTED_LANGS = ["vi", "en"]; // Danh sách các ngôn ngữ hệ thống hỗ trợ đồng bộ

if (!NOTION_TOKEN || !DATABASE_ID) {
    console.error("❌ Missing NOTION_TOKEN or NOTION_DATABASE_ID in .env");
    process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

// ─── Category display names & ordering ────────────────────
const CATEGORY_DISPLAY = {
    vi: {
        introduction: "Giới thiệu",
        "getting-started": "Bắt đầu",
        agents: "Tạo và cấu hình Agent",
        knowledge: "Kiến thức",
        tools: "Tools",
        workflow: "Work Flow",
        chatflow: "Chat Flow",
        features: "Tính năng mở rộng",
        channels: "Kết nối đa kênh",
        developers: "Developers",
        faq: "FAQ",
    },
    en: {
        introduction: "Introduction",
        "getting-started": "Getting Started",
        agents: "Agent Setup",
        knowledge: "Knowledge Base",
        tools: "Tools",
        workflow: "Work Flow",
        chatflow: "Chat Flow",
        features: "Advanced Features",
        channels: "Channels",
        developers: "Developers",
        faq: "FAQ",
    },
};

// Explicit sidebar ordering (categories appear in this order)
const CATEGORY_ORDER = [
    "introduction",
    "getting-started",
    "agents",
    "knowledge",
    "tools",
    "workflow",
    "chatflow",
    "features",
    "channels",
    "developers",
    "faq",
];

// ─── Helpers ──────────────────────────────────────────────

/** Get plain text from a Notion rich_text array */
function getPlainText(richTextArr) {
    if (!richTextArr || !Array.isArray(richTextArr)) return "";
    return richTextArr.map((t) => t.plain_text).join("");
}

/** Get a select property value */
function getSelect(prop) {
    return prop?.select?.name || "";
}

/** Get a number property value */
function getNumber(prop) {
    return prop?.number ?? 999;
}

/** Get page title */
function getTitle(prop) {
    return prop?.title ? getPlainText(prop.title) : "";
}

/** Ensure a directory exists */
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/** Sanitize filename/slug */
function sanitizeSlug(slug) {
    return slug.replace(/[^a-z0-9_-]/g, "").toLowerCase();
}

// ─── Image Download Helpers (Xử lý tải ảnh) ───────────────────────────────

/**
 * Tải file ảnh từ URL (thường là URL Amazon S3 của Notion) về lưu cứng ở thư mục dự án cục bộ (local).
 * Trả về true nếu tải thành công, và false nếu lỗi.
 */
function downloadImage(url, destPath) {
    return new Promise((resolve) => {
        const client = url.startsWith("https") ? https : http;
        const request = client.get(url, { timeout: 15000 }, (response) => {
            // Follow redirects
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                downloadImage(response.headers.location, destPath).then(resolve);
                return;
            }
            if (response.statusCode !== 200) {
                console.warn(`    ⚠️  HTTP ${response.statusCode} for image: ${path.basename(destPath)}`);
                resolve(false);
                return;
            }
            const fileStream = fs.createWriteStream(destPath);
            response.pipe(fileStream);
            fileStream.on("finish", () => { fileStream.close(); resolve(true); });
            fileStream.on("error", () => { resolve(false); });
        });
        request.on("error", (err) => {
            console.warn(`    ⚠️  Download failed for ${path.basename(destPath)}: ${err.message}`);
            resolve(false);
        });
        request.on("timeout", () => {
            request.destroy();
            resolve(false);
        });
    });
}

/**
 * Quét toàn bộ nội dung file (Markdown) tìm các link ảnh do Notion xuất ra (AWS S3)
 * tự động tải ảnh về lưu vào thư mục `images/<category>/...` 
 * và gắn lại (replace) link đường dẫn cục bộ (local) vào file nội dung.
 * Việc này giúp link ảnh không bao giờ bị hết hạn/chết link như mặc định của Notion.
 */
async function processImages(content, categorySlug) {
    // Match markdown images: ![alt](url)
    const imageRegex = /!\[([^\]]*)\]\((https:\/\/prod-files-secure\.s3\.us-west-2\.amazonaws\.com\/[^)]+)\)/g;

    const matches = [...content.matchAll(imageRegex)];
    if (matches.length === 0) return content;

    const imagesDir = path.join(ROOT_DIR, "images", categorySlug);
    ensureDir(imagesDir);

    let updatedContent = content;

    for (const match of matches) {
        const [fullMatch, altText, imageUrl] = match;

        // Extract the unique object ID from the S3 URL to create a stable filename
        // URL format: .../15aeec36-.../96d7f864-dd84-4df0-.../image.png?...
        const pathParts = new URL(imageUrl).pathname.split("/");
        const objectId = pathParts[pathParts.length - 2] || "";  // UUID before filename
        const originalFilename = pathParts[pathParts.length - 1] || "image.png";
        const ext = path.extname(originalFilename) || ".png";

        // Create a short stable filename from the object ID
        const hash = createHash("md5").update(objectId).digest("hex").substring(0, 8);
        const localFilename = `${categorySlug}-${hash}${ext}`;
        const localPath = path.join(imagesDir, localFilename);
        const mdPath = `/images/${categorySlug}/${localFilename}`;

        // Download if not already cached
        if (!fs.existsSync(localPath)) {
            console.log(`    📥 Downloading image: ${localFilename}`);
            const success = await downloadImage(imageUrl, localPath);
            if (!success) {
                console.warn(`    ⚠️  Skipping image (download failed): ${localFilename}`);
                continue;
            }
        } else {
            console.log(`    ✅ Image cached: ${localFilename}`);
        }

        // Replace the S3 URL with local path
        updatedContent = updatedContent.replace(fullMatch, `![${altText}](${mdPath})`);
    }

    return updatedContent;
}

// ─── Main Sync (Cốt lõi luồng đồng bộ) ────────────────────────────────────────────

/**
 * BƯỚC 1: Truy vấn Database từ Notion
 * Hàm này gọi API lên Notion, tải danh sách các trang (Pages) kèm theo bộ lọc:
 * 1. Thuộc về các ngôn ngữ đang hỗ trợ (vi, en)
 * 2. Cột "Status" phải mang giá trị khác "Chưa bắt đầu"
 */
async function queryDatabase() {
    console.log(`\n📡 Querying Notion database (all supported languages)...`);

    const pages = [];
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
        const response = await notion.databases.query({
            database_id: DATABASE_ID,
            filter: {
                and: [
                    {
                        or: SUPPORTED_LANGS.map((lang) => ({
                            property: "Lang",
                            select: { equals: lang },
                        })),
                    },
                    {
                        property: "Status",
                        status: { does_not_equal: "Chưa bắt đầu" },
                    },
                ],
            },
            sorts: [
                { property: "Lang", direction: "ascending" },
                { property: "CategorySlug", direction: "ascending" },
                { property: "Order", direction: "ascending" },
            ],
            start_cursor: startCursor,
        });

        pages.push(...response.results);
        hasMore = response.has_more;
        startCursor = response.next_cursor;
    }

    console.log(`✅ Found ${pages.length} pages total`);
    return pages;
}

/**
 * BƯỚC 2: Chuyển đổi một trang Notion thành định dạng MDX của Mintlify
 * Quá trình chuyển đổi gồm:
 * - Đọc cấu trúc Block trên Notion và biên dịch thành raw Markdown (.md)
 * - Xử lý escape ký tự đặc biệt ({}, <, >) để Mintlify không bị lỗi biên dịch JSX
 * - Tiến hành tải cục bộ tất cả hình ảnh nếu bài viết đó có ảnh (processImages)
 * - Thiết lập đoạn đầu file MDX (Frontmatter) với title, mô tả.
 */
async function convertPageToMdx(page) {
    const props = page.properties;

    const name = getTitle(props.Name);
    const slug = getPlainText(props.Slug?.rich_text);
    const category = getSelect(props.Category);
    const categorySlug = getPlainText(props.CategorySlug?.rich_text);
    const order = getNumber(props.Order);
    const lang = getSelect(props.Lang);

    if (!slug || !categorySlug) {
        console.warn(`⚠️  Skipping "${name}" — missing slug or categorySlug`);
        return null;
    }

    console.log(`  📄 Converting: ${name} → ${categorySlug}/${slug}.mdx`);

    try {
        // Convert Notion blocks to markdown
        const mdBlocks = await n2m.pageToMarkdown(page.id);
        const mdString = n2m.toMarkdownString(mdBlocks);

        // Handle different return formats from notion-to-md
        let content = "";
        if (typeof mdString === "string") {
            content = mdString;
        } else if (mdString && typeof mdString === "object") {
            content = mdString.parent || "";
        }

        // Escape curly braces for MDX compatibility (JSX expressions)
        content = content
            .replace(/(?<!\\)\{(?!\s*\/\*)/g, "\\{")
            .replace(/(?<!\\)\}(?!\s*\*\/)/g, "\\}")
            .replace(/<br>/g, "<br/>");

        // Escape angle brackets used as comparison operators (not HTML tags)
        // e.g. (<200) or (>2000) or (>10) — MDX treats these as JSX
        content = content.replace(/\((<)(\d)/g, "(\\$1$2");
        content = content.replace(/\((>)(\d)/g, "(\\$1$2");

        // Download images locally and replace S3 URLs with local paths
        content = await processImages(content, categorySlug);

        // Build MDX frontmatter
        const escapedName = name.replace(/"/g, '\\"');
        const frontmatter = [
            "---",
            `title: "${escapedName}"`,
            `sidebarTitle: "${escapedName}"`,
            `description: "${escapedName} - AI Hive Documentation"`,
            "---",
            "",
        ].join("\n");

        return {
            name,
            slug: sanitizeSlug(slug),
            category,
            categorySlug,
            order,
            lang,
            content: frontmatter + content,
        };
    } catch (err) {
        console.warn(`  ⚠️  Error converting "${name}": ${err.message}`);
        return null;
    }
}

/**
 * BƯỚC 3: Ghi các nội dung MDX đã xử lý xong xuống thành file lưu ở thư mục hệ thống.
 * - Bài viết thuộc DEFAULT_LANG (vi): Sẽ được lưu ở thư mục gốc (Ví dụ: /features/tinh-nang.mdx)
 * - Bài viết khác (en): Được lưu vào folder tiền tố ngỗn ngữ (Ví dụ: /en/features/tinh-nang.mdx)
 */
function writePages(pages, lang) {
    const isDefault = lang === DEFAULT_LANG;
    const prefix = isDefault ? "" : `${lang}/`;
    console.log(`\n📝 Writing MDX files for [${lang}]...`);

    for (const page of pages) {
        const dir = isDefault
            ? path.join(ROOT_DIR, page.categorySlug)
            : path.join(ROOT_DIR, lang, page.categorySlug);
        ensureDir(dir);
        const filePath = path.join(dir, `${page.slug}.mdx`);
        fs.writeFileSync(filePath, page.content, "utf-8");
        console.log(`  ✅ ${prefix}${page.categorySlug}/${page.slug}.mdx`);
    }
}

/**
 * Hàm hỗ trợ: Gom nhóm (Group) các bài viết theo Category, sau đó tạo cấu trúc Menu điều hướng.
 * Hàm này cũng có trách nhiệm chèn (inject) các trang cứng (như chat-flow tiếng Việt)
 * vào lại cấu trúc nếu file tài liệu đó không có phiên bản (row) trong Database Notion.
 */
function buildNavGroups(pages, lang) {
    const displayNames = CATEGORY_DISPLAY[lang] || CATEGORY_DISPLAY[DEFAULT_LANG];

    // Group pages by categorySlug
    const grouped = {};
    for (const p of pages) {
        if (!grouped[p.categorySlug]) {
            grouped[p.categorySlug] = {
                category: p.category,
                categorySlug: p.categorySlug,
                pages: [],
            };
        }
        grouped[p.categorySlug].pages.push(`${p.categorySlug}/${p.slug}`);
    }

    // Sort by CATEGORY_ORDER
    const sortedSlugs = Object.keys(grouped).sort((a, b) => {
        const ia = CATEGORY_ORDER.indexOf(a);
        const ib = CATEGORY_ORDER.indexOf(b);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });

    const groups = sortedSlugs.map((slug) => {
        const g = grouped[slug];
        return {
            group: displayNames[g.categorySlug] || g.category,
            pages: g.pages,
        };
    });

    // Add index page to the first group
    if (groups.length > 0) {
        groups[0].pages.unshift("index");
    }

    // Auto-inject missing pages that are not in Notion DB but exist locally
    if (lang === DEFAULT_LANG) {
        let hasChatFlow = false;
        for (const g of groups) {
            if (g.group === displayNames["chatflow"]) hasChatFlow = true;
        }
        if (!hasChatFlow) {
            groups.push({
                group: displayNames["chatflow"],
                pages: ["chatflow/chat-flow"]
            });
            // Re-sort after injection
            groups.sort((a, b) => {
                const aSlug = Object.keys(displayNames).find(key => displayNames[key] === a.group);
                const bSlug = Object.keys(displayNames).find(key => displayNames[key] === b.group);
                const ia = CATEGORY_ORDER.indexOf(aSlug);
                const ib = CATEGORY_ORDER.indexOf(bSlug);
                return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
            });
        }
    }

    return groups;
}

/**
 * BƯỚC 4: Tự động ghi đè và thiết lập cấu hình file docs.json (Tạo sidebar cho Website)
 * Dựa trên toàn bộ danh sách file đã tải về, tạo Sidebar riêng cho từng ngôn ngữ (vi, en).
 * Đồng thời đẩy cấu hình mảng "languages" vào trong "navigation" để Mintlify bật Switcher Ngôn ngữ ở góc trang.
 */
function updateDocsJson(pagesByLang) {
    console.log("\n⚙️  Updating docs.json navigation...");

    const docsJsonPath = path.join(ROOT_DIR, "docs.json");
    const docsJson = JSON.parse(fs.readFileSync(docsJsonPath, "utf-8"));

    // Tab name per language
    const tabNames = { vi: "Hướng dẫn", en: "Guide" };

    // Build default language groups for main tabs (fallback)
    const defaultPages = pagesByLang[DEFAULT_LANG] || [];
    const defaultGroups = buildNavGroups(defaultPages, DEFAULT_LANG);

    if (docsJson.navigation?.tabs?.[0]) {
        docsJson.navigation.tabs[0].tab = tabNames[DEFAULT_LANG] || "Docs";
        docsJson.navigation.tabs[0].groups = defaultGroups;
    }

    // Build ALL languages into the languages array (so switcher shows all)
    const languages = [];
    for (const lang of SUPPORTED_LANGS) {
        const langPages = pagesByLang[lang];
        if (!langPages || langPages.length === 0) continue;

        const langGroups = buildNavGroups(langPages, lang);

        // Non-default languages need prefixed paths (e.g. en/introduction/...)
        if (lang !== DEFAULT_LANG) {
            for (const group of langGroups) {
                group.pages = group.pages.map((p) =>
                    p === "index" ? `${lang}/index` : `${lang}/${p}`
                );
            }
        }

        languages.push({
            language: lang,
            tabs: [
                {
                    tab: tabNames[lang] || "Docs",
                    groups: langGroups,
                },
            ],
        });
    }

    // Set languages config INSIDE navigation (required for language switcher)
    if (languages.length > 0) {
        docsJson.navigation.languages = languages;
    }
    // Remove any stale root-level languages key
    delete docsJson.languages;

    fs.writeFileSync(docsJsonPath, JSON.stringify(docsJson, null, 2), "utf-8");
    console.log("  ✅ docs.json updated with multi-language navigation");
}

// ─── Run (Chạy kịch bản) ──────────────────────────────────────────────────

/**
 * HÀM THỰC THI CHÍNH (Kết nối các hàm trên theo đúng chuỗi dây chuyền)
 * Luồng chạy: 
 * 1. Lấy dữ liệu (queryDatabase) -> 2. Xử lý từng trang (convertPageToMdx) 
 * -> 3. Phân loại theo ngôn ngữ -> 4. Ghi file cứng (writePages) -> 5. Sắp xếp lại Sidebar Menu (updateDocsJson).
 */
async function main() {
    console.log("🚀 AI Hive Docs — Notion Sync (Multi-language)");
    console.log("════════════════════════════════════");
    console.log(`   Default language: ${DEFAULT_LANG}`);
    console.log(`   Supported: ${SUPPORTED_LANGS.join(", ")}`);

    try {
        // 1. Query Notion (all languages, Status != "Chưa bắt đầu")
        const rawPages = await queryDatabase();

        // 2. Convert each page
        const convertedPages = [];
        for (const page of rawPages) {
            const result = await convertPageToMdx(page);
            if (result) convertedPages.push(result);
        }

        if (convertedPages.length === 0) {
            console.log("\n⚠️  No pages to sync. Check your Notion DB filters.");
            return;
        }

        // 3. Group pages by language
        const pagesByLang = {};
        for (const page of convertedPages) {
            const lang = page.lang || DEFAULT_LANG;
            if (!pagesByLang[lang]) pagesByLang[lang] = [];
            pagesByLang[lang].push(page);
        }

        // 4. Write MDX files for each language
        for (const lang of Object.keys(pagesByLang)) {
            writePages(pagesByLang[lang], lang);
        }

        // 5. Update docs.json navigation (multi-language)
        updateDocsJson(pagesByLang);

        // Summary
        console.log("\n════════════════════════════════════");
        for (const [lang, pages] of Object.entries(pagesByLang)) {
            console.log(`  [${lang}] ${pages.length} pages`);
        }
        console.log(`✅ Synced ${convertedPages.length} pages successfully!`);
        console.log("   Run 'npx mintlify dev' to preview.\n");
    } catch (error) {
        console.error("\n❌ Sync failed:", error.message);
        if (error.code === "unauthorized") {
            console.error("   → Check your NOTION_TOKEN in .env");
        }
        if (error.code === "object_not_found") {
            console.error("   → Check your NOTION_DATABASE_ID in .env");
            console.error(
                "   → Make sure the integration has access to the database"
            );
        }
        process.exit(1);
    }
}

main();
