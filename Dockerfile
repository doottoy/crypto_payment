FROM node:18
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run app:build
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/app.js"]
