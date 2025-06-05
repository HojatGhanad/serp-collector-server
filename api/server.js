const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'serp_collector',
  user: process.env.DB_USER || 'serp_user',
  password: process.env.DB_PASS || 'serp_pass',
  port: process.env.DB_PORT || 5432,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error acquiring client', err.stack);
  } else {
    console.log('Database connected successfully');
    release();
  }
});

// Simple API key validation middleware
function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

// Error handler
function handleError(res, error, message = 'Internal server error') {
  console.error('Error:', error);
  res.status(500).json({ error: message, details: error.message });
}

// === Extension Endpoints ===

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Get next query (extensions don't see project info)
app.get('/api/v1/queries/next', validateApiKey, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE queries 
       SET status = 'processing', processed_at = CURRENT_TIMESTAMP 
       WHERE id = (
         SELECT id FROM queries 
         WHERE status = 'pending' 
         ORDER BY priority DESC, created_at 
         LIMIT 1
       ) 
       RETURNING id, search_term`,
      []
    );
    
    if (result.rows.length > 0) {
      res.json({
        query_id: result.rows[0].id,
        search_term: result.rows[0].search_term,
        max_pages: 5
      });
    } else {
      res.json(null);
    }
  } catch (error) {
    handleError(res, error, 'Failed to get next query');
  }
});

// Save results from extension
app.post('/api/v1/results', validateApiKey, async (req, res) => {
  const { query_id, pages, suggestions, related_searches, total_results } = req.body;
  
  if (!query_id || !pages) {
    return res.status(400).json({ error: 'Missing required fields: query_id, pages' });
  }

  try {
    await pool.query('BEGIN');
    
    // Insert results
    for (const page of pages) {
      if (page.results && Array.isArray(page.results)) {
        for (const result of page.results) {
          await pool.query(
            `INSERT INTO results 
             (query_id, page_number, position, title, url, domain, description, result_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              query_id, 
              page.page_number, 
              result.position, 
              result.title, 
              result.url, 
              result.domain, 
              result.description, 
              result.type || 'organic'
            ]
          );
        }
      }
    }
    
    // Insert suggestions
    if (suggestions && Array.isArray(suggestions)) {
      for (const suggestion of suggestions) {
        await pool.query(
          'INSERT INTO suggestions (query_id, suggestion) VALUES ($1, $2)',
          [query_id, suggestion]
        );
      }
    }
    
    // Insert related searches
    if (related_searches && Array.isArray(related_searches)) {
      for (const related of related_searches) {
        await pool.query(
          'INSERT INTO related_searches (query_id, search_term) VALUES ($1, $2)',
          [query_id, related]
        );
      }
    }
    
    // Update query status
    await pool.query(
      'UPDATE queries SET status = $1 WHERE id = $2',
      ['completed', query_id]
    );
    
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await pool.query('ROLLBACK');
    handleError(res, error, 'Failed to save results');
  }
});

// === Internal Admin Endpoints (no auth for MVP) ===

// List projects
app.get('/api/v1/admin/projects', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM projects WHERE is_active = true ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    handleError(res, error, 'Failed to fetch projects');
  }
});

// Create new project
app.post('/api/v1/admin/projects', async (req, res) => {
  const { name, description } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Project name is required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING *',
      [name, description]
    );
    res.json(result.rows[0]);
  } catch (error) {
    handleError(res, error, 'Failed to create project');
  }
});

// Add queries to project
app.post('/api/v1/admin/projects/:project_id/queries', async (req, res) => {
  const { project_id } = req.params;
  const { queries, priority = 0 } = req.body;
  
  if (!queries || !Array.isArray(queries) || queries.length === 0) {
    return res.status(400).json({ error: 'Queries array is required' });
  }

  try {
    let inserted = 0;
    for (const query of queries) {
      if (query && query.trim()) {
        await pool.query(
          'INSERT INTO queries (project_id, search_term, priority) VALUES ($1, $2, $3)',
          [project_id, query.trim(), priority]
        );
        inserted++;
      }
    }
    
    res.json({ success: true, inserted });
  } catch (error) {
    handleError(res, error, 'Failed to add queries');
  }
});

// Get project stats
app.get('/api/v1/admin/projects/:project_id/stats', async (req, res) => {
  const { project_id } = req.params;
  
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'processing') as processing,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) as total
      FROM queries
      WHERE project_id = $1
    `, [project_id]);
    
    const domains = await pool.query(`
      SELECT domain, COUNT(*) as count
      FROM results r
      JOIN queries q ON r.query_id = q.id
      WHERE q.project_id = $1 AND domain IS NOT NULL
      GROUP BY domain
      ORDER BY count DESC
      LIMIT 10
    `, [project_id]);
    
    res.json({
      queries: stats.rows[0],
      top_domains: domains.rows
    });
  } catch (error) {
    handleError(res, error, 'Failed to get project stats');
  }
});

// List queries with filters
app.get('/api/v1/admin/queries', async (req, res) => {
  const { status, project_id, limit = 50, offset = 0 } = req.query;
  
  try {
    let whereConditions = [];
    let params = [];
    
    if (status) {
      whereConditions.push(`q.status = $${params.length + 1}`);
      params.push(status);
    }
    
    if (project_id) {
      whereConditions.push(`q.project_id = $${params.length + 1}`);
      params.push(project_id);
    }
    
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(`
      SELECT q.*, p.name as project_name
      FROM queries q
      JOIN projects p ON q.project_id = p.id
      ${whereClause}
      ORDER BY q.priority DESC, q.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    
    res.json(result.rows);
  } catch (error) {
    handleError(res, error, 'Failed to fetch queries');
  }
});

// Get query results
app.get('/api/v1/admin/queries/:query_id/results', async (req, res) => {
  const { query_id } = req.params;
  
  try {
    const results = await pool.query(`
      SELECT * FROM results 
      WHERE query_id = $1 
      ORDER BY page_number, position
    `, [query_id]);
    
    const suggestions = await pool.query(`
      SELECT suggestion FROM suggestions 
      WHERE query_id = $1
    `, [query_id]);
    
    const related = await pool.query(`
      SELECT search_term FROM related_searches 
      WHERE query_id = $1
    `, [query_id]);
    
    res.json({
      results: results.rows,
      suggestions: suggestions.rows.map(row => row.suggestion),
      related_searches: related.rows.map(row => row.search_term)
    });
  } catch (error) {
    handleError(res, error, 'Failed to fetch query results');
  }
});

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`SERP Collector API server running on port ${port}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  pool.end(() => {
    console.log('Database connections closed');
    process.exit(0);
  });
});