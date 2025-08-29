// tag_all.js — posa brand i category a tots els products a Postgres
import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

async function run() {
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS brand TEXT;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT;`);

  // ── BRAND (heurístic)
  await pool.query(`UPDATE products SET brand='Nike'
    WHERE (brand IS NULL OR brand='') AND name ~* '(\\bNike\\b|Dunk|Cortez|Pegasus|P-?6000|Air\\s?Force|TN\\b|Vomero|Peg|Zoom)'`);
  await pool.query(`UPDATE products SET brand='Adidas'
    WHERE (brand IS NULL OR brand='') AND name ~* '(\\bAdidas\\b|Samba|Gazelle|Campus|Forum|Stan\\s?Smith|Superstar|Yeezy)'`);
  await pool.query(`UPDATE products SET brand='Jordan'
    WHERE (brand IS NULL OR brand='') AND name ~* '(\\bJordan\\b|AJ\\s?\\d|Jordan\\s?\\d)'`);
  await pool.query(`UPDATE products SET brand='New Balance'
    WHERE (brand IS NULL OR brand='') AND name ~* '(New\\s?Balance|\\bNB\\b|\\bNB\\s?\\d{3}\\b|550|530|2002R|990|991|992)'`);
  await pool.query(`UPDATE products SET brand='ASICS'
    WHERE (brand IS NULL OR brand='') AND name ~* '(ASICS|Gel[-\\s]?|Kayano|Nimbus)'`);
  await pool.query(`UPDATE products SET brand='Puma'
    WHERE (brand IS NULL OR brand='') AND name ~* '(\\bPuma\\b|Suede|RS-?X)'`);
  await pool.query(`UPDATE products SET brand='Reebok'
    WHERE (brand IS NULL OR brand='') AND name ~* '(Reebok|Club\\s?C|Classic)'`);

  // ── CATEGORY (bàsic)
  await pool.query(`UPDATE products SET category='Roba'
    WHERE (category IS NULL OR category='') AND name ~* '(hoodie|sudadera|chaqueta|cazadora|pantal(|ó|o)n|short|bermuda|camiseta|t-?shirt|tee|jacket|chandal|tracksuit|top|calcetines|socks)'`);
  await pool.query(`UPDATE products SET category='Sabates'
    WHERE (category IS NULL OR category='')`); // resta per defecte

  const brands = (await pool.query(`SELECT COALESCE(brand,'(sense)') b, COUNT(*) n FROM products GROUP BY 1 ORDER BY n DESC`)).rows;
  const cats   = (await pool.query(`SELECT COALESCE(category,'(sense)') c, COUNT(*) n FROM products GROUP BY 1 ORDER BY n DESC`)).rows;

  console.log('BRANDS:', brands.map(x=>`${x.b}:${x.n}`).join(' | '));
  console.log('CATEGORIES:', cats.map(x=>`${x.c}:${x.n}`).join(' | '));
}

run().catch(e => { console.error('ERROR', e); process.exit(1); })
     .finally(async () => { try { await pool.end(); } catch {} });
