const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const path = require('path');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const { format } = require('date-fns');
const rateLimit = require('express-rate-limit');
const expressLayouts = require('express-ejs-layouts');

const app = express();
const PORT = process.env.PORT || 3000;

// Security and rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});

// Middleware Setup
app.use(limiter);
app.use(morgan('dev'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// View Engine Setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// Configure marked options
marked.setOptions({
    breaks: true,
    gfm: true,
    headerIds: true,
    sanitize: false
});

// Custom middleware for logging
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.url}`);
    next();
});

// Utility Functions
async function readPosts() {
    try {
        const data = await fs.readFile(path.join(__dirname, 'data', 'posts.json'), 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // If file doesn't exist, create it with empty posts array
            const initialData = { posts: [] };
            await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
            await fs.writeFile(
                path.join(__dirname, 'data', 'posts.json'),
                JSON.stringify(initialData, null, 2)
            );
            return initialData;
        }
        throw error;
    }
}

async function writePosts(posts) {
    await fs.writeFile(
        path.join(__dirname, 'data', 'posts.json'),
        JSON.stringify(posts, null, 2)
    );
}

function processPostContent(content) {
    const htmlContent = marked(content);
    return sanitizeHtml(htmlContent, {
        allowedTags: [
            ...sanitizeHtml.defaults.allowedTags,
            'img',
            'h1',
            'h2',
            'h3'
        ],
        allowedAttributes: {
            ...sanitizeHtml.defaults.allowedAttributes,
            'a': ['href', 'target', 'rel'],
            'img': ['src', 'alt', 'title']
        }
    });
}

// Routes
app.get('/', async (req, res) => {
    try {
        const { posts } = await readPosts();
        const sortedPosts = [...posts].sort((a, b) => 
            new Date(b.createdAt) - new Date(a.createdAt)
        );
        const featuredPosts = sortedPosts.slice(0, 3);
        
        res.render('home', {
            title: 'Welcome to Modern Blog',
            featuredPosts,
            formatDate: format
        });
    } catch (error) {
        console.error('Home page error:', error);
        res.status(500).render('error', {
            title: 'Error',
            error: 'Error loading homepage'
        });
    }
});

app.get('/posts', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 6;
        const { posts } = await readPosts();
        
        const sortedPosts = [...posts].sort((a, b) => 
            new Date(b.createdAt) - new Date(a.createdAt)
        );
        
        const totalPosts = sortedPosts.length;
        const totalPages = Math.ceil(totalPosts / limit);
        const offset = (page - 1) * limit;
        
        const paginatedPosts = sortedPosts.slice(offset, offset + limit);
        
        res.render('posts', {
            title: 'All Blog Posts',
            posts: paginatedPosts,
            currentPage: page,
            totalPages,
            formatDate: format
        });
    } catch (error) {
        console.error('Posts page error:', error);
        res.status(500).render('error', {
            title: 'Error',
            error: 'Error loading posts'
        });
    }
});

app.get('/post', async (req, res) => {
    try {
        const id = parseInt(req.query.id);
        const { posts } = await readPosts();
        const post = posts.find(p => p.id === id);
        
        if (!post) {
            return res.status(404).render('error', {
                title: 'Error',
                error: 'Post not found'
            });
        }
        
        // Sort posts by date for navigation
        const sortedPosts = [...posts].sort((a, b) => 
            new Date(b.createdAt) - new Date(a.createdAt)
        );
        const currentIndex = sortedPosts.findIndex(p => p.id === id);
        
        const prevPost = currentIndex < sortedPosts.length - 1 ? 
            sortedPosts[currentIndex + 1] : null;
        const nextPost = currentIndex > 0 ? 
            sortedPosts[currentIndex - 1] : null;
        
        post.processedContent = processPostContent(post.content);
        
        res.render('post', {
            title: post.title,
            post,
            prevPost,
            nextPost,
            formatDate: format
        });
    } catch (error) {
        console.error('Single post error:', error);
        res.status(500).render('error', {
            title: 'Error',
            error: 'Error loading post'
        });
    }
});

app.get('/add-post', (req, res) => {
    res.render('add-post', {
        title: 'Add New Post',
        preview: null
    });
});

app.post('/preview-post', (req, res) => {
    try {
        const { content } = req.body;
        const processedContent = processPostContent(content);
        res.json({ preview: processedContent });
    } catch (error) {
        console.error('Preview error:', error);
        res.status(500).json({ 
            error: 'Error generating preview'
        });
    }
});

app.post('/add-post', async (req, res) => {
    try {
        const { title, content, author, excerpt } = req.body;
        
        if (!title || !content || !author) {
            return res.status(400).render('error', {
                title: 'Error',
                error: 'All fields are required'
            });
        }

        const { posts } = await readPosts();
        const newPost = {
            id: posts.length > 0 ? Math.max(...posts.map(p => p.id)) + 1 : 1,
            title: sanitizeHtml(title),
            content,
            excerpt: sanitizeHtml(excerpt || content.substring(0, 150) + '...'),
            author: sanitizeHtml(author),
            createdAt: new Date().toISOString(),
            readingTime: Math.ceil(content.split(/\s+/).length / 200)
        };
        
        posts.push(newPost);
        await writePosts({ posts });
        
        res.redirect(`/post?id=${newPost.id}`);
    } catch (error) {
        console.error('Add post error:', error);
        res.status(500).render('error', {
            title: 'Error',
            error: 'Error saving post'
        });
    }
});

app.get('/search', async (req, res) => {
    try {
        const query = (req.query.q || '').toLowerCase();
        if (!query) {
            return res.redirect('/');
        }

        const { posts } = await readPosts();
        const searchResults = posts.filter(post => 
            post.title.toLowerCase().includes(query) ||
            post.content.toLowerCase().includes(query) ||
            post.author.toLowerCase().includes(query)
        ).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        res.render('search', {
            title: 'Search Results',
            query: req.query.q,
            posts: searchResults,
            formatDate: format
        });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).render('error', {
            title: 'Error',
            error: 'Error performing search'
        });
    }
});

// Error handling middleware
app.use((req, res) => {
    res.status(404).render('error', {
        title: 'Error',
        error: 'Page not found'
    });
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).render('error', {
        title: 'Error',
        error: 'Something went wrong!'
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Modern blog server running at http://localhost:${PORT}`);
});