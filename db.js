import 'dotenv/config';
`);
}


export const db = {
insertProduct: (name, description='') =>
pool.query('INSERT INTO products(name, description) VALUES($1,$2) RETURNING id', [name, description]).then(r=>r.rows[0]),
listProducts: () =>
pool.query('SELECT * FROM products ORDER BY id DESC LIMIT 100').then(r=>r.rows),
listProductsLike: (q) =>
pool.query('SELECT * FROM products WHERE name ILIKE $1 ORDER BY id DESC LIMIT 25', [q]).then(r=>r.rows),
getProduct: (id) =>
pool.query('SELECT * FROM products WHERE id=$1', [id]).then(r=>r.rows[0]),


insertVariant: (product_id, option_name, option_value, price_cents, stock, cost_cents=0) =>
pool.query('INSERT INTO variants(product_id, option_name, option_value, price_cents, stock, cost_cents) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [product_id, option_name, option_value, price_cents, stock, cost_cents]).then(r=>r.rows[0]),
getVariantsOfProduct: (pid) =>
pool.query('SELECT * FROM variants WHERE product_id=$1 ORDER BY id ASC', [pid]).then(r=>r.rows),
getVariant: (id) =>
pool.query('SELECT * FROM variants WHERE id=$1',[id]).then(r=>r.rows[0]),
decStock: (variant_id, qty) =>
pool.query('UPDATE variants SET stock = stock - $1 WHERE id=$2 AND stock >= $1', [qty, variant_id]),


insertOrder: (user_id, username, items_json, total_cents, total_cost_cents) =>
pool.query('INSERT INTO orders(user_id, username, items_json, total_cents, total_cost_cents) VALUES($1,$2,$3,$4,$5)', [user_id, username, items_json, total_cents, total_cost_cents]),
listOrders: () =>
pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 100').then(r=>r.rows),


insertQuery: (user_id, username, text) =>
pool.query('INSERT INTO queries(user_id, username, text) VALUES($1,$2,$3)', [user_id, username, text]),
listQueries: () =>
pool.query('SELECT * FROM queries ORDER BY id DESC LIMIT 200').then(r=>r.rows),


salesSummary: () =>
pool.query(`
SELECT
date_trunc('day', created_at) AS day,
SUM(total_cents) AS rev,
SUM(total_cost_cents) AS cog,
SUM(total_cents - total_cost_cents) AS margin
FROM orders
GROUP BY 1
ORDER BY 1 DESC
LIMIT 30;
`).then(r=>r.rows)
};


export default pool;