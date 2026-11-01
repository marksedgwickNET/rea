FROM node:22.19-bookworm-slim
ENV NODE_ENV=production
WORKDIR /opt
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
ARG REA_COMMIT=d672cc23998b6cbb21c485f118595ebfb82fed33
RUN git init /opt/rea && git -C /opt/rea remote add origin https://github.com/marksedgwickNET/rea.git \
    && git -C /opt/rea fetch --depth 1 origin ${REA_COMMIT} \
    && git -C /opt/rea checkout --detach FETCH_HEAD
WORKDIR /opt/rea
RUN npm ci && npm run build:cached
WORKDIR /opt/rea-gateway
COPY gateway/server.mjs ./server.mjs
ENV REA_DIR=/opt/rea
EXPOSE 10000
CMD ["node", "server.mjs"]
