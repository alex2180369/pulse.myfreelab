# Один образ на трекер. Какой именно собирать, задаёт аргумент CASE.
FROM node:22-alpine
ARG CASE=01_zadachi
WORKDIR /srv
COPY core ./core
COPY cases/${CASE}/app ./cases/${CASE}/app
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 CASE=${CASE}
USER node
EXPOSE 8801
CMD ["sh", "-c", "exec node --disable-warning=ExperimentalWarning cases/$CASE/app/server.js"]
