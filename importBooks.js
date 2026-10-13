const mongoose = require('mongoose')

async function importBooks() {

    try {

        // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI)
       .then(() => console.log('Connected to MongoDB Atlas'))
       

        // Get books from Open Library
         const response = await fetch(
            'https://openlibrary.org/search.json?q=the+alchemist&fields=key,title,cover_i,description,author_name,subject&limit=10'
        )


        const data = await response.json()

        // Convert API data into our MongoDB format
        const books = data.docs.map(book => {

            return {
                image: book.cover_i
                    ? `https://covers.openlibrary.org/b/id/${book.cover_i}-L.jpg`
                    : '',

                name: book.title || 'Unknown',

                description: book.description || 'No description available.',
            
                
                categories: book.subject || []

            }

        })

        // Insert into MongoDB
        const collection = mongoose.connection.db.collection('Book_Details')
        
        await collection.insertMany(books)

        console.log(`${books.length} books inserted successfully`)

        await mongoose.disconnect()

    } catch (error) {

        console.error('Error:', error.message)

    }
}

importBooks()