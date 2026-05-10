require('dotenv').config();
const express = require('express');
const path = require('path');

const { testDb } = require('./db');

const authRoutes = require('./routes/auth.routes');
const usersRoutes = require('./routes/users.routes');
const dataRoutes = require('./routes/data.routes');
const requestsRoutes = require('./routes/requests.routes');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

// Routes
app.use(authRoutes);
app.use(usersRoutes);
app.use(dataRoutes);
app.use(requestsRoutes);

testDb();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server listening on', PORT);
});
