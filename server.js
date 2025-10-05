// server/server.js
import express from 'express';
import puppeteer from 'puppeteer';
import cors from 'cors';
import path from "path";
import { error } from "console";
import fs from "fs";
import cron from "node-cron";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});


const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

function extractProblemTitle(url) {
  try {
    // Extract search query from URL like: 
    // https://www.geeksforgeeks.org/search/?gq=Two%20Sum
    const urlObj = new URL(url);
    const searchParams = urlObj.searchParams;
    const query = searchParams.get('gq');
    return query ? decodeURIComponent(query) : null;
  } catch {
    return null;
  }
}

// ✅ Modified /api/get-details endpoint with Redis cache
app.post('/api/get-details', async (req, res) => {
  let { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Missing URL' });
  }

  try {
    // 🔍 Step 1: Try to get data from Redis cache
    const problemTitle = extractProblemTitle(url);
    
    if (problemTitle) {
      console.log(`Checking cache for: ${problemTitle}`);
      
      const cachedData = await redis.hgetall(problemTitle);
      
      // If cache hit, return immediately
      if (cachedData && Object.keys(cachedData).length > 0) {
        console.log(`✓ Cache HIT for: ${problemTitle}`);
        
        return res.json({
          time: cachedData.time || null,
          space: cachedData.space || null,
          companyNames: cachedData.companyNames ? JSON.parse(cachedData.companyNames) : [],
          topics: cachedData.topics ? JSON.parse(cachedData.topics) : [],
          source: 'cache' // Indicate data came from cache
        });
      }
      
      console.log(`✗ Cache MISS for: ${problemTitle}`);
    }

    // 🌐 Step 2: If cache miss, scrape with Puppeteer
    console.log('Fetching from Puppeteer...');
    
    const browser = await puppeteer.launch({
      headless: true, // ✅ Fixed: was 'new', should be boolean
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

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

    // 💾 Step 3: Cache the result in Redis for future requests
    if (problemTitle && result) {
      console.log(`Caching data for: ${problemTitle}`);
      
      await redis.hset(problemTitle, {
        time: result.time || 'N/A',
        space: result.space || 'N/A',
        companyNames: JSON.stringify(result.companyNames || []),
        topics: JSON.stringify(result.topics || []),
      });
    }

    // Return the scraped data
    res.json({
      ...result,
      source: 'puppeteer' // Indicate data came from live scraping
    });

  } catch (error) {
    console.error('Scraping error:', error.message);
    res.status(500).json({ error: 'Failed to get details' });
  }
});

// ✅ /api/get-button-link endpoint (no caching needed here)
app.post('/api/get-button-link', async (req, res) => {
  let { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Missing URL' });
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

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
  // replace invalid characters with "_"
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

  // If available, click it
  await page.evaluate((lang) => {
    const btn = document.querySelector(`.code-tab[data-lang="${lang}"]`);
    if (btn) btn.click();
  }, lang);

  
  await page.evaluate((lang) => {
    // console.log(lang);
  //  try {
  //   if (lang === "java" || lang === "cpp" || lang === "python" || lang === "javascript") {
  //     const btn = document.querySelector(`.code-tab[data-lang="${lang}"]`);
  //     if (btn) {
  //       btn.click();
  //     } else {
  //       console.error("No tab button found for", lang);
  //     }
  //   }
  // } catch (err) {
  //   console.error("Error while switching tab:", err.message);
  // }
    
// Expand details
  document.querySelectorAll("details").forEach(d => d.setAttribute("open", "true"));
  const firstDiv = document.querySelector(".h-screen");
  if (firstDiv) {
    firstDiv.style.overflow = "visible";
    firstDiv.style.overflowX = "visible";
    firstDiv.style.overflowY = "visible";
    firstDiv.style.height = "auto";
  }    
  const btn = document.querySelector(".theme-toggle");
  btn.click();

  const th = document.getElementsByClassName('sticky top-10');
  th[0].remove();  //ad removed
  const el = document.getElementsByClassName("w-full flex-col"); 
  el[5].classList.remove("md:w-[80%]");   //full screen
  const el2 = document.querySelector('.mt-\\[56px\\].lg\\:mt-0');
  el2.remove();     //header removed
  const el3 = document.querySelector('.bg-white.dark\\:bg-\\[\\#161A20\\]');
  el3.remove();   //header removed
  
}, lang);

// await page.waitForSelector(`.code-block[data-lang="${lang}"].dsa_article_code_active`, { timeout: 5000 });


//yt logo
let el =await page.$('.dsa_article_youtube_video');
if(el){
  await page.waitForSelector('.dsa_article_youtube_video', { timeout: 5000 });
  await page.evaluate(() => {
    document.querySelectorAll('.dsa_article_youtube_video').forEach(el => el.remove());
  });
}else{
  el = await page.$('ytp-cued-thumbnail-overlay-image');
    if(el){
        await page.evaluate(() => {
        document.querySelectorAll('.dsa_article_youtube_video').forEach(el => el.remove());
        });
  }
}


//acknowledgment block
const el2 = await page.$('.wp-block-quote');
if (el2){
  await page.waitForSelector('.wp-block-quote', { timeout: 5000 });
await page.evaluate(() => {
  document.querySelectorAll('.wp-block-quote').forEach(el => el.remove());
});
}


//track content block 
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
      -webkit-text-fill-color: #000000 !important; /* force fill color */
      -webkit-text-stroke: 0px #000000 !important;
    }
  `
});

await page.addStyleTag({
  content: `
    * {
      -webkit-font-smoothing: none !important;
      -moz-osx-font-smoothing: auto !important;
      text-shadow: 0 0 0 currentColor !important; /* tiny trick to boost weight */
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
  const ell = document.querySelectorAll('.code-block dsa_article_code_active, .code-content');
  if(ell){
      document.querySelectorAll('.code-block dsa_article_code_active, .code-content').forEach(el => {
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
      background: #ffffffff !important; /* remove grey */
    }
    
  `
});

let title = await page.title();
// const filePath = await getUniqueFileName(title, "pdf");
title = sanitizeFileName(await page.title());


  // await page.pdf({
  //   path: filePath,
  //   format: "A4",
  //   printBackground: true,
  //   margin: {
  //   top: "10px",
  //   right: "10px",
  //   bottom: "10px",
  //   left: "10px"
  // }
  // });

const pdfBuffer = await page.pdf({
  format: "A4",
  printBackground: true,
  margin: { top: "10px", right: "10px", bottom: "10px", left: "10px" }
});
  await browser.close();
  return {pdfBuffer,title};
};

const { pdfBuffer, title } = await getPdf(url, lang);
//   res.set({
//   "Content-Type": "application/pdf",
//   "Content-Disposition": `attachment; filename="${title}.pdf"`,
//   "Content-Length": pdfBuffer.length,
// });
// console.log("Downloaded");
// res.send(pdfBuffer);
res.setHeader("Content-Type", "application/pdf");
res.setHeader("Content-Disposition", `attachment; filename="${title}.pdf"`);
res.setHeader("Content-Length", pdfBuffer.length);
// Expose header so browser JS can read Content-Disposition
res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
console.log("Downloaded PDF size:", pdfBuffer.length);
res.end(pdfBuffer);



  }catch(err){
    console.error(err);
    // Check if it's a language availability error
    // if (err.message.includes('Language') && err.message.includes('not available')) {
    //   res.status(400).json({ success: false, error: err.message });
    // } else {
    //   res.status(500).json({ success: false, error: err.message });
    // }
    res.status(400).json({ success: false, error: err.message });
  }

});


app.listen(PORT, () => {
  console.log(`Puppeteer server running at http://localhost:${PORT}`);
});
