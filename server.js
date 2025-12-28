import express from 'express';
import puppeteer from 'puppeteer';
import cors from 'cors';
import path from "path";
import { error } from "console";
import fs from "fs";
import cron from "node-cron";
import { Redis } from "@upstash/redis";
import dotenv from "dotenv";
dotenv.config();

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

async function checkInRedis(title) {
  try {

    const check = await redis.hgetall(title);
    return check ? title : null;
  } catch {
    return null;
  }
}

function safeParse(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return [value]; 
  }
}

app.post('/api/get-details', async (req, res) => {
  let { url,title } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Missing URL' });
  }

  try {

    const problemTitle = await checkInRedis(title);
    console.log(title);
    console.log(problemTitle);

    if (problemTitle) {
      console.log(`Checking cache for: ${problemTitle}`);

      const cachedData = await redis.hgetall(problemTitle);

      if (cachedData && Object.keys(cachedData).length > 0) {
        console.log(`✓ Cache HIT for: ${problemTitle}`);

        return res.json({
          time: cachedData.time || null,
          space: cachedData.space || null,
          companyNames: safeParse(cachedData.companyNames),
          topics: safeParse(cachedData.topics),
        });
      }

      console.log(`✗ Cache MISS for: ${problemTitle}`);
    }

    console.log('Fetching from Puppeteer...');

    const browser = await puppeteer.launch({
      headless: true, 
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    const candidateSelectors = [
      'button.ResultArticle_articleContainer__headerLink--problem__jb1Dv',
      'button[class*="headerLink"][class*="problem"]',
      'a[class*="headerLink"][class*="problem"]',
      'a[aria-label*="Problem" i]',
      'button[aria-label*="Problem" i]'
    ];

    const candidateXPaths = [
      "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'problem')]",
      "//a[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'problem')]",
      "//a[contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'problem')]",
      "//button[contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'problem')]"
    ];

    let clicked = false;
    for (const sel of candidateSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 4000 });
        await page.click(sel);
        clicked = true;
        break;
      } catch {}
    }

    if (!clicked) {
      for (const xp of candidateXPaths) {
        try {
          const [el] = await page.$x(xp);
          if (el) {
            await el.click();
            clicked = true;
            break;
          }
        } catch {}
      }
    }

    if (!clicked) {
      await browser.close();
      throw new Error('Problem link/button not found');
    }

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
    await page.waitForSelector('[class^="problems_expected_complexities_text"]', { timeout: 5000 }).catch(() => {});

    const result = await page.evaluate(() => {
      function getTextSafe(el) {
        return (el && el.textContent && el.textContent.trim()) || null;
      }

      let complexityContainer = document.querySelector('[class^="problems_expected_complexities_text"]');
      if (!complexityContainer) {
        complexityContainer = document.querySelector('.problems_expected_complexities_text');
      }

      let time = null;
      let space = null;

      if (complexityContainer) {
        const first = complexityContainer.querySelector('div');
        const second = complexityContainer.querySelector('div:nth-child(2)');
        time = getTextSafe(first);
        space = getTextSafe(second);
      }

      const checkDiv = document.querySelector('div[class*="problems_active_tags"]');
      let companyNames, topics;

      if (checkDiv) {
        const labelBlocks = Array.from(document.querySelectorAll('.ui.labels'));
        const companyBlock = labelBlocks[0] || null;
        const topicBlock = labelBlocks[1] || null;

        companyNames = companyBlock
          ? Array.from(companyBlock.querySelectorAll('a')).map(a => a.textContent.trim())
          : [];

        topics = topicBlock
          ? Array.from(topicBlock.querySelectorAll('a')).map(a => a.textContent.trim())
          : [];
      } else {
        companyNames = null;
        const labelBlocks = Array.from(document.querySelectorAll('.ui.labels'));
        const topicBlock = labelBlocks[0] || null;
        topics = topicBlock
          ? Array.from(topicBlock.querySelectorAll('a')).map(a => a.textContent.trim())
          : [];
      }

      return { time, space, companyNames, topics };
    });

    await browser.close();

    if (problemTitle && result) {
      console.log(`Caching data for: ${problemTitle}`);

      await redis.hset(problemTitle, {
        time: result.time || 'N/A',
        space: result.space || 'N/A',
        companyNames: JSON.stringify(result.companyNames || []),
        topics: JSON.stringify(result.topics || []),
      });
    }

    res.json({
      ...result,
      source: 'puppeteer' 
    });

  } catch (error) {
    console.error('Scraping error:', error.message);
    res.status(500).json({ error: 'Failed to get details' });
  }
});

app.post('/api/get-button-link', async (req, res) => {
  let { url,title } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Missing URL' });
  }

    const problemTitle = await checkInRedis(title);
    console.log(title);
    console.log(problemTitle);

    if (problemTitle) {
      console.log(`Checking cache for: ${problemTitle}`);

      const cachedData = await redis.hgetall(problemTitle);

      if (cachedData && Object.keys(cachedData).length > 0) {
        console.log(`✓ Cache HIT for: ${problemTitle}`);

        return res.json({
          link: cachedData.url || null,
        });
      }

      console.log(`✗ Cache MISS for: ${problemTitle}`);
    }

  try {
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    const candidateSelectors = [
      'button.ResultArticle_articleContainer__headerLink--problem__jb1Dv',
      'button[class*="headerLink"][class*="problem"]',
      'a[class*="headerLink"][class*="problem"]',
      'a[aria-label*="Problem" i]',
      'button[aria-label*="Problem" i]'
    ];

    const candidateXPaths = [
      "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'problem')]",
      "//a[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'problem')]",
      "//a[contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'problem')]",
      "//button[contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'problem')]"
    ];

    let clicked = false;
    for (const sel of candidateSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 4000 });
        await page.click(sel);
        clicked = true;
        break;
      } catch {}
    }

    if (!clicked) {
      for (const xp of candidateXPaths) {
        try {
          const [el] = await page.$x(xp);
          if (el) {
            await el.click();
            clicked = true;
            break;
          }
        } catch {}
      }
    }

    if (!clicked) {
      await browser.close();
      throw new Error('Problem link/button not found');
    }

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});

    const newUrl = page.url();
    await browser.close();

    res.json({ link: newUrl });

  } catch (error) {
    console.error('Scraping error:', error.message);
    res.status(500).json({ error: 'Failed to get link from button click' });
  }
});

app.post('/api/download-pdf', async(req,res) => {
  console.log('Incoming body:', req.body);
  let {url,lang} = req.body;
  console.log(lang);

  try{
    function sanitizeFileName(name) {

  return name.replace(/[<>:"/\\|?*]+/g, "_");
}

async function getUniqueFileName(baseName, ext) {
  baseName = sanitizeFileName(baseName);
  let fileName = `${baseName}.${ext}`;
  let counter = 0;

  while (fs.existsSync(fileName)) {
    counter++;
    fileName = `${baseName}${counter}.${ext}`;
  }

  return fileName;
}

async function getPdf(url,lang) {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process"
    ]
  });

  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(90000);
  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 90000
  });
  const hasLang = await page.$(`.code-tab[data-lang="${lang}"]`);

  if (!hasLang) {
    await browser.close();
    throw Error(`This note is not available in ${lang} language!`);
  }

  await page.evaluate((lang) => {
    const btn = document.querySelector(`.code-tab[data-lang="${lang}"]`);
    if (btn) btn.click();
  }, lang);

  await page.evaluate((lang) => {

  document.querySelectorAll("details").forEach(d => d.setAttribute("open", "true"));
  const firstDiv = document.querySelector(".h-screen");
  if (firstDiv) {
    firstDiv.style.overflow = "visible";
    firstDiv.style.overflowX = "visible";
    firstDiv.style.overflowY = "visible";
    firstDiv.style.height = "auto";
  }    
  // const btn = document.querySelector(".theme-toggle");
  // btn.click();
  const btn = document.querySelector(".theme-toggle");
  if (btn) {
     btn.click();
  } else {
    console.log("Theme toggle button not found — skipping click");
  }

  const th = document.getElementsByClassName('sticky top-10');
  if (th && th.length > 0 && th[0]) {
    th[0].remove();
  }
   
  const el = document.getElementsByClassName("w-full flex-col"); 
  if (el && el.length > 5 && el[5]) {
    el[5].classList?.remove("md:w-[80%]");
  }
    
  const el2 = document.querySelector('.mt-\\[56px\\].lg\\:mt-0');
  if(el2){ 
    el2.remove();
  }else{
    console.log("Checked and not found");
  }
  const el3 = document.querySelector('.bg-white.dark\\:bg-\\[\\#161A20\\]');
  if(el3){ 
    el3.remove();
  }else{
    console.log("Checked and not found");
  }

}, lang);

let el =await page.$('.dsa_article_youtube_video');
if(el){
  await page.waitForSelector('.dsa_article_youtube_video', { timeout: 5000 });
  await page.evaluate(() => {
    document.querySelectorAll('.dsa_article_youtube_video').forEach(el => el?.remove());
  });
}else{
  el = await page.$('ytp-cued-thumbnail-overlay-image');
    if(el){
        await page.evaluate(() => {
        document.querySelectorAll('.dsa_article_youtube_video').forEach(el => el.remove());
        });
  }
}

const el2 = await page.$('.wp-block-quote');
if (el2){
  await page.waitForSelector('.wp-block-quote', { timeout: 5000 });
await page.evaluate(() => {
  document.querySelectorAll('.wp-block-quote').forEach(el => el?.remove());
});
}

const btn = await page.$('button.fixed.lg\\:hidden');
if (btn) {
  await page.waitForSelector('button.fixed.lg\\:hidden', { timeout: 5000 });

  await page.evaluate(() => {
    const el = document.querySelector('button.fixed.lg\\:hidden');
    if (el) el.remove();
  });
}

await page.addStyleTag({
  content: `
    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      color-adjust: exact !important;
      color: #000000 !important;
    }

    body, p, span, div, strong, em, h1, h2, h3, h4, h5, h6, a {
      color: #000000 !important;
      -webkit-text-fill-color: #000000 !important; 
      -webkit-text-stroke: 0px #000000 !important;
    }
  `
});

await page.addStyleTag({
  content: `
    * {
      -webkit-font-smoothing: none !important;
      -moz-osx-font-smoothing: auto !important;
      text-shadow: 0 0 0 currentColor !important; 
    }
  `
});

  await page.evaluate(() => {
  const scroller = document.querySelector(".scroll-container");
  if (scroller) {
    scroller.style.height = "auto";
    scroller.style.overflow = "visible";
  }
});

  
await page.evaluate(() => {

  // remove dark mode
  document.documentElement.classList.remove("dark");

  // remove overflow-hidden everywhere
  document.querySelectorAll(".overflow-hidden").forEach(el => {
    el.classList.remove("overflow-hidden");
  });

});


  
await page.evaluate(() => {
  const ell = document.querySelectorAll('.code-block .dsa_article_code_active, .code-content');
  if (ell && ell.length > 0) {
    ell.forEach(el => {
      el.style.maxHeight = 'none';
      el.style.height = 'auto';
      el.style.overflow = 'visible';
    });
  }
});


await page.addStyleTag({
  content: `
    header, .sticky, .fixed, .top-0, .top-10 {
      display: none !important;
    }
    body, html {
      margin: 0 !important;
      padding: 0 !important;
      background: #ffffffff !important; 
    }

  `
});

let title = await page.title();

title = sanitizeFileName(await page.title());

const pdfBuffer = await page.pdf({
  format: "A4",
  printBackground: true,
  margin: { top: "10px", right: "10px", bottom: "10px", left: "10px" }
});
  await browser.close();
  return {pdfBuffer,title};
};

const { pdfBuffer, title } = await getPdf(url, lang);

res.setHeader("Content-Type", "application/pdf");
res.setHeader("Content-Disposition", `attachment; filename="${title}.pdf"`);
res.setHeader("Content-Length", pdfBuffer.length);

res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
console.log("Downloaded PDF size:", pdfBuffer.length);
res.end(pdfBuffer);

  }catch(err){
    console.error(err);

    res.status(400).json({ success: false, error: err.message });
  }

});

app.listen(PORT, () => {
  console.log(`Puppeteer server running at http://localhost:${PORT}`);
});

