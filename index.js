require('dotenv').config()
const express = require('express')
const session = require('express-session')
const mongoose = require('mongoose')
const nodemailer = require('nodemailer')
const multer = require('multer')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const User = require('./models/User')
const Order = require('./models/Order')

const app = express()
app.set('trust proxy', 1)
const ADMIN_USERNAME = 'admin'
const ADMIN_PASSWORD = '1234'
const bookPrice = Number(process.env.BOOK_PRICE) > 0 ? Number(process.env.BOOK_PRICE) : 499

const bookCategories = ['Fiction', 'Fantasy', 'Science Fiction', 'History', 'Romance', 'Mystery', 'Education', 'Biography', 'Children']
const imageExtensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }

const imageUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(__dirname, 'images', 'uploads')
            fs.mkdir(dir, { recursive: true }, error => cb(error, dir))
        },
        filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${imageExtensions[file.mimetype]}`)
    }),
    fileFilter: (req, file, cb) => cb(null, Boolean(imageExtensions[file.mimetype])),
    limits: { fileSize: 5 * 1024 * 1024 }
})

// Open Library subject -> our category
const categoryRules = [
    ['fiction', 'Fiction'], ['fantasy', 'Fantasy'], ['science fiction', 'Science Fiction'],
    ['history', 'History'], ['historical', 'History'], ['romance', 'Romance'], ['mystery', 'Mystery'],
    ['biography', 'Biography'], ['autobiography', 'Biography'], ['children', 'Children'], ['juvenile', 'Children']
]

function getCategories(subjects = []) {
    const found = []
    subjects.forEach(subject => {
        const s = (typeof subject === 'string' ? subject : subject.name || '').toLowerCase()
        categoryRules.forEach(([word, category]) => s.includes(word) && found.push(category))
    })
    return [...new Set(found)]
}

async function start() {
    try {
        await mongoose.connect(process.env.MONGODB_URI, { dbName: 'bookstore' })
        console.log('Connected to MongoDB Atlas:', mongoose.connection.name)
        
    } catch (err) {
        console.error('MongoDB error:', err.message)
        process.exit(1)
    }
}

const booksCollection = () => mongoose.connection.db.collection('Book_Details')
const coverUrl = id => `https://covers.openlibrary.org/b/id/${id}-L.jpg`
const isId = id => mongoose.Types.ObjectId.isValid(id)

app.use(express.static('images'))
app.use(express.urlencoded({ extended: true }))
app.set('view engine', 'ejs')

const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined
})

app.use(session({
    secret: process.env.SESSION_SECRET || 'development-only-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}))

app.use((req, res, next) => {
    res.locals.isadmin = req.session.isAdmin === true
    res.locals.currentUser = req.session.user || null
    res.locals.cartCount = (req.session.cart || []).reduce((count, item) => count + item.quantity, 0)
    next()
})

// ---------- helpers ----------
function requireLogin(req, res, next) {
    if (req.session.user) return next()
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`)
}

function isAdmin(req, res, next) {
    req.session.isAdmin ? next() : res.send('Access Denied ')
}

const safeNextPath = value =>
    typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/books'

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(`${salt}:${key.toString('hex')}`))
    })
}

async function passwordMatches(password, storedHash) {
    const [salt, hash] = (storedHash || '').split(':')
    if (!salt || !hash) return false
    const candidate = Buffer.from((await hashPassword(password, salt)).split(':')[1], 'hex')
    const stored = Buffer.from(hash, 'hex')
    return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate)
}

const cartTotal = (cart = []) => cart.reduce((total, item) => total + item.price * item.quantity, 0)

// new session after login/register, keeping the cart
function startUserSession(req, res, user, next) {
    const cart = req.session.cart || []
    req.session.regenerate(error => {
        if (error) return res.status(500).send('Could not start your session.')
        req.session.cart = cart
        req.session.user = { id: String(user._id), name: user.name, email: user.email }
        res.redirect(next)
    })
}

function destroySession(req, res) {
    req.session.destroy(error => {
        if (error) return res.status(500).send('Unable to logout.')
        res.clearCookie('connect.sid')
        res.redirect('/books')
    })
}

function normalizeOpenLibraryId(value) {
    if (typeof value !== 'string') return ''
    return value.replace(/^\/works\//, '')
}

async function fetchWork(bookId) {
    const normalizedId = normalizeOpenLibraryId(String(bookId || ''))
    const response = await fetch(`https://openlibrary.org/works/${normalizedId}.json`)
    if (!response.ok) return null
    const book = await response.json()
    const subjects = book.subjects || []
    return {
        openLibraryId: book.key,
        name: book.title || 'Unknown',
        description: book.description
            ? (typeof book.description === 'string' ? book.description : book.description.value)
            : 'Description not available',
        image: book.covers && book.covers.length ? coverUrl(book.covers[0]) : '',
        year: book.first_publish_date || '',
        subjects,
        categories: getCategories(subjects),
        isBookmarked: true,
        savedAt: new Date()
    }
}

// ---------- cart ----------
app.get('/cart', (req, res) => {
    const cart = req.session.cart || []
    res.render('cart', { cart, total: cartTotal(cart) })
})

app.post('/cart/add', async (req, res) => {
    try {
        const bookId = (req.body.bookId || '').trim()
        let book
        if (/^\/works\/OL[0-9]+W$/.test(bookId)) {
            const response = await fetch(`https://openlibrary.org${bookId}.json`)
            if (!response.ok) return res.status(404).send('Book not found.')
            const work = await response.json()
            const coverId = work.covers && work.covers[0]
            book = { id: bookId, name: work.title || 'Unknown', image: coverId ? coverUrl(coverId) : '' }
        } else if (isId(bookId)) {
            const saved = await booksCollection().findOne({ _id: new mongoose.Types.ObjectId(bookId) })
            if (!saved) return res.status(404).send('Book not found.')
            book = { id: String(saved._id), name: saved.name || 'Unknown', image: saved.image || '' }
        } else {
            return res.status(400).send('Invalid book.')
        }

        const cart = req.session.cart || (req.session.cart = [])
        const existing = cart.find(item => item.id === book.id)
        if (existing) existing.quantity = Math.min(existing.quantity + 1, 99)
        else cart.push({ ...book, price: bookPrice, quantity: 1 })
        req.session.save((error) => {
    if (error) {
        console.error('Cart session save error:', error)
        return res.status(500).send('Could not save your cart.')
    }

    res.redirect('/cart')
})
    } catch (error) {
        console.error('Could not add book to cart:', error.message)
        res.status(500).send('Could not add book to cart.')
    }
})

app.post('/cart/update', (req, res) => {
    const quantity = Number.parseInt(req.body.quantity, 10)
    const item = (req.session.cart || []).find(entry => entry.id === req.body.bookId)
    if (item && Number.isInteger(quantity)) item.quantity = Math.max(1, Math.min(quantity, 99))
    res.redirect('/cart')
})

app.post('/cart/remove', (req, res) => {
    req.session.cart = (req.session.cart || []).filter(item => item.id !== req.body.bookId)
    res.redirect('/cart')
})

// ---------- user auth ----------
app.get('/register', (req, res) => res.render('register', { error: '', next: safeNextPath(req.query.next) }))

app.post('/register', async (req, res) => {
    const name = (req.body.name || '').trim()
    const email = (req.body.email || '').trim().toLowerCase()
    const password = req.body.password || ''
    const next = safeNextPath(req.body.next)
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) {
        return res.status(400).render('register', { error: 'Enter a name, valid email, and password of at least 8 characters.', next })
    }
    try {
        const user = await User.create({ name, email, passwordHash: await hashPassword(password) })
        startUserSession(req, res, user, next)
    } catch (error) {
        const duplicate = error.code === 11000
        res.status(duplicate ? 409 : 500).render('register', {
            error: duplicate ? 'An account with this email already exists.' : 'Could not create your account.',
            next
        })
    }
})

app.get('/login', (req, res) => res.render('login', { error: '', next: safeNextPath(req.query.next) }))

app.post('/login', async (req, res) => {
    const email = (req.body.email || '').trim().toLowerCase()
    const next = safeNextPath(req.body.next)
    try {
        const user = await User.findOne({ email })
        if (!user || !await passwordMatches(req.body.password || '', user.passwordHash)) {
            return res.status(401).render('login', { error: 'Email or password is incorrect.', next })
        }
        startUserSession(req, res, user, next)
    } catch (error) {
        console.error('Login error:', error.message)
        res.status(500).render('login', { error: 'Could not sign in. Please try again.', next })
    }
})

app.post('/logout', destroySession)

// ---------- checkout & orders ----------
app.get('/checkout', requireLogin, (req, res) => {
    const cart = req.session.cart || []
    if (!cart.length) return res.redirect('/cart')
    res.render('checkout', { cart, total: cartTotal(cart), user: req.session.user, error: '' })
})

app.post('/checkout', requireLogin, async (req, res) => {
    const cart = req.session.cart || []
    if (!cart.length) return res.redirect('/cart')
    const customer = {}
    ;['name', 'email', 'phone', 'address', 'city', 'postalCode'].forEach(key => {
        customer[key] = (req.body[key] || '').trim()
    })
    customer.email = customer.email.toLowerCase()

    const fail = (status, error) => res.status(status).render('checkout', {
        cart, total: cartTotal(cart), user: { ...req.session.user, ...customer }, error
    })
    if (Object.values(customer).some(value => !value)) return fail(400, 'Complete all delivery details.')

    try {
        const total = cartTotal(cart)
        const order = await Order.create({
            user: req.session.user.id,
            customer,
            items: cart.map(({ id, name, image, price, quantity }) => ({ bookId: id, name, image, price, quantity })),
            total,
            paymentMethod: 'Cash on Delivery'
        })

        const itemSummary = cart.map(item => ({
            name: item.name,
            quantity: item.quantity,
            amount: item.quantity * item.price
        }))

        const emailLines = [
            'Order placed successfully',
            'Order ID:' + order._id,
            `Name: ${customer.name}`,
            `Phone: ${customer.phone}`,
            `Address: ${customer.address}`,
            `City: ${customer.city}`,
            `Postal Code: ${customer.postalCode}`,
            ...itemSummary.map(item => `Book: ${item.name}\nQuantity: ${item.quantity}\nAmount: ₹${Number(item.amount).toFixed(2)}`),
            `Total Bill: ₹${Number(total).toFixed(2)}`,
            'Thank you for choosing OpenLibrary.'
        ]

        const mailText = emailLines.join('\n\n')

        const smtpConfigured = Boolean(process.env.SMTP_USER && process.env.SMTP_PASS)
        if (!smtpConfigured) {
            console.warn('SMTP credentials are missing. Add SMTP_USER and SMTP_PASS in .env to receive order emails.')
        }

        if (smtpConfigured && customer.email) {
            try {
                await transport.sendMail({
                    from: process.env.SMTP_USER,
                    to: customer.email,
                    subject: 'Order placed successfully',
                    text: mailText
                })
                console.log('Order confirmation email sent to:', customer.email)
            } catch (mailError) {
                console.error('Could not send order confirmation email:', mailError.message)
            }
        }

        req.session.cart = []
        res.redirect(`/orders/${order._id}`)
    } catch (error) {
        console.error('Could not create order:', error.message)
        fail(500, 'Could not place your order. Please try again.')
    }
})

app.get('/orders/:id', requireLogin, async (req, res) => {
    if (!isId(req.params.id)) return res.status(404).send('Order not found.')
    try {
        const order = await Order.findOne({ _id: req.params.id, user: req.session.user.id }).lean()
        if (!order) return res.status(404).send('Order not found.')
        res.render('order', { order })
    } catch (error) {
        console.error('Could not load order:', error.message)
        res.status(500).send('Could not load order.')
    }
})

// ---------- pages & admin auth ----------
app.get('/', (req, res) => res.render('home'))
app.get('/about', (req, res) => res.render('about'))
app.get('/contact', (req, res) => res.render('contact'))
app.get('/admin/login', (req, res) => res.render('adminlogin'))


app.post('/admin/login', (req, res) => {
    const username = (req.body.username || '').trim()
    const password = req.body.password || ''

    if (
        username !== ADMIN_USERNAME ||
        password !== ADMIN_PASSWORD
    ) {
        return res.status(401).send('Invalid username or password')
    }

    req.session.regenerate((error) => {
        if (error) {
            console.error('Admin session error:', error)
            return res.status(500).send('Could not start admin session.')
        }

        req.session.isAdmin = true

        req.session.save((saveError) => {
            if (saveError) {
                console.error('Admin session save error:', saveError)
                return res.status(500).send('Could not save admin session.')
            }

            res.redirect('/books')
        })
    })
})


app.post('/admin/logout', destroySession)

// ---------- books ----------
app.get('/books', async (req, res) => {
    const search = (req.query.search || '').trim()
    try {
        if (search) {
            const url = new URL('https://openlibrary.org/search.json')
            url.searchParams.set('q', search)
            url.searchParams.set('fields', 'key,title,cover_i,author_name,first_publish_year,subject')
            url.searchParams.set('limit', '20')

            const response = await fetch(url)
            if (!response.ok) throw new Error('Open Library API request failed')
            const data = await response.json()

            const books = data.docs.map(book => ({
                id: book.key,
                name: book.title || 'Unknown',
                image: book.cover_i ? coverUrl(book.cover_i) : '',
                description: book.author_name ? book.author_name.join(', ') : 'Author not listed',
                year: book.first_publish_year || '',
                categories: getCategories(book.subject || [])
            }))
            return res.render('books', { books, search, fromDatabase: false })
        }

        const books = await booksCollection().find({}).sort({ savedAt: -1 }).toArray()
        res.render('books', { books, search, fromDatabase: true, isadmin: req.session.isAdmin || false })
    } catch (err) {
        console.error('Could not load books:', err.message)
        res.status(500).send('Could not load books.')
    }
})

app.get('/books/:id', async (req, res) => {
    try {
        const bookId = req.params.id

        if (isId(bookId)) {
            const savedBook = await booksCollection().findOne({ _id: new mongoose.Types.ObjectId(bookId) })
            if (savedBook) {
                return res.render('bookDetails', {
                    book: {
                        ...savedBook,
                        openLibraryId: savedBook.openLibraryId || `/works/${savedBook._id}`,
                        isBookmarked: true
                    }
                })
            }
        }

        const book = await fetchWork(bookId)
        if (!book) return res.status(404).send('Book not found')
        res.render('bookDetails', { book })
    } catch (err) {
        console.error(err.message)
        res.status(500).send('Could not load book')
    }
})

// toggle bookmark: saves the book if new, removes it if already saved
app.post('/books/bookmark/:id', async (req, res) => {
    try {
        const collection = booksCollection()
        const openLibraryId = `/works/${req.params.id}`

        const existing = await collection.findOne({ openLibraryId })
        if (existing) {
            await collection.deleteOne({ openLibraryId })
            return res.json({ isBookmarked: false })
        }

        const book = await fetchWork(req.params.id)
        if (!book) throw new Error('Book not found in Open Library')
        book.year = book.year || 'Unknown'
        await collection.insertOne(book)
        res.json({ isBookmarked: true })
    } catch (err) {
        console.error('Bookmark error:', err.message)
        res.status(500).json({ message: 'Could not update bookmark' })
    }
})

app.get('/category', async (req, res) => {
    try {
        const selectedCategory = req.query.category || 'All'
        const query = selectedCategory === 'All' ? {} : { categories: selectedCategory }
        const books = await booksCollection().find(query).sort({ savedAt: -1 }).toArray()
        res.render('categories', { books, selectedCategory })
    } catch (error) {
        console.error('Category error:', error.message)
        res.status(500).send('Could not load categories')
    }
})

app.get('/books/:id/edit', isAdmin, async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(400).send('Invalid book ID.')
        const book = await booksCollection().findOne({ _id: new mongoose.Types.ObjectId(req.params.id) })
        if (!book) return res.status(404).send('Book not found.')
        res.render('editBook', { book, categories: bookCategories, error: '' })
    } catch (err) {
        console.error('Could not load book for editing:', err.message)
        res.status(500).send('Could not load book for editing.')
    }
})

app.post('/books/:id/edit', isAdmin, imageUpload.single('image'), async (req, res) => {
    const removeUploadedImage = () => req.file && fs.promises.unlink(req.file.path).catch(() => {})
    const reject = async (status, message) => {
        await removeUploadedImage()
        return res.status(status).send(message)
    }

    try {
        if (!isId(req.params.id)) return reject(400, 'Invalid book ID.')
        const collection = booksCollection()
        const bookId = new mongoose.Types.ObjectId(req.params.id)
        const book = await collection.findOne({ _id: bookId })
        if (!book) return reject(404, 'Book not found.')

        const name = (req.body.name || '').trim()
        if (!name) return reject(400, 'Book name is required.')

        const selected = [].concat(req.body.categories || [])
        await collection.updateOne({ _id: bookId }, {
            $set: {
                name,
                year: (req.body.year || '').trim(),
                description: (req.body.description || '').trim(),
                categories: selected.filter(category => bookCategories.includes(category)),
                image: req.file ? `/uploads/${req.file.filename}` : book.image
            }
        })
        res.redirect('/books')
    } catch (err) {
        await removeUploadedImage()
        console.error('Could not update book:', err.message)
        res.status(500).send('Could not update book.')
    }
})

app.post('/books/:id/delete', isAdmin, async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(400).send('Invalid book ID.')
        await booksCollection().deleteOne({ _id: new mongoose.Types.ObjectId(req.params.id) })
        res.redirect('/books')
    } catch (err) {
        console.error('Could not delete book:', err.message)
        res.status(500).send('Could not delete book.')
    }
})

// ---------- contact ----------
app.post('/contact', (req, res) => {
    const { name, email, tel, message } = req.body
    const recipient = (process.env.CONTACT_TO || process.env.SMTP_USER || '').trim()

    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.warn('Contact email not sent: SMTP_USER and SMTP_PASS are missing in .env.')
        return res.status(500).send('Email not sent. Please configure SMTP credentials in .env.')
    }

    if (!recipient) {
        console.warn('Contact email not sent: CONTACT_TO/SMTP_USER is missing in .env.')
        return res.status(500).send('Email not sent. Missing contact email configuration.')
    }

    transport.sendMail({
        from: process.env.SMTP_USER,
        to: recipient,
        replyTo: email,
        subject: 'New Message from OpenLibrary Contact Form',
        text: `Name: ${name}\nEmail: ${email}\nPhone: ${tel}\nMessage: ${message}`
    }, error => {
        if (error) {
            console.error('Contact email error:', error)
            return res.status(500).send('Email not sent')
        }
        res.send(`<script>alert('Email sent successfully'); window.location.href = '/contact'</script>`)
    })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Listening on ${PORT}`))
start()