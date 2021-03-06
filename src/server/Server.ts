import {Request, Response} from "express"
import {ServerSocketEventsHelper} from "./ServerSocketEventsHelper"
import {
    DomainSocket,
    GameEventsHandler,
    ServerAsteroid,
    ServerBullet,
    ServerGameData,
    ServerPlayer
} from "./ServerModels"
import {RGBColor} from "react-color"
import {PlayerInputDTO} from "../shared/DTOs"

const paths = require('../../config/paths');
const express = require('express')
const app = express()
const http = require('http').Server(app)
const port = process.env.PORT || '3000'
const io = require('socket.io')(http)

app.use(express.static('build'))

app.get('/', (req: Request, res: Response) => {
    // when user connects to this server, send index.html which will connect to this server via websocket
    res.sendFile(paths.appHtml, { root: paths.appBuild })
})

class Server implements GameEventsHandler {
    // update game logic (e.g. position, collision detection) at rate 60fps approx.
    private readonly gameUpdateInterval = 1000 / 60
    private readonly connectedSockets: DomainSocket[] = []

    private readonly gameData: ServerGameData = new ServerGameData(this)

    constructor() {
        this.gameUpdateLoop = this.gameUpdateLoop.bind(this)
    }

    start(port: string): void {
        http.listen(port, () => {
            console.info(`Listening on port ${port}`)
        })

        ServerSocketEventsHelper.subscribeConnectedEvent(io, socket => {
            this.onConnectedEvent(socket)
        })

        setTimeout(this.gameUpdateLoop, this.gameUpdateInterval)
    }

    // new socket connected
    private onConnectedEvent(socket: DomainSocket): void {
        console.log(`socket id ${socket.id} connected`)
        this.connectedSockets.push(socket)

        ServerSocketEventsHelper.subscribeDisconnectedEvent(socket, () => {
            this.onDisconnectedEvent(socket)
        })

        ServerSocketEventsHelper.subscribeTryLoggingInEvent(socket, (name, color) => {
            this.onTryLoggingInEvent(socket, name, color)
        })

        ServerSocketEventsHelper.subscribePlayerInputEvent(socket, playerInput => {
            this.onPlayerInputEvent(socket, playerInput)
        })
    }

    // socket disconnected (by user closing tab or refreshing etc)
    private onDisconnectedEvent(socket: DomainSocket): void {
        console.log(`socket id ${socket.id} disconnected`)
        const i = this.connectedSockets.findIndex(value => value.id === socket.id)
        if (i >= 0) {
            this.connectedSockets.splice(i, 1)
        }

        if (socket.me) {
            this.gameData.removePlayerById(socket.me.id)
            this.gameData.recycleBulletsByFirerId(socket.me.id)
            ServerSocketEventsHelper.sendPlayerLeftEvent(socket, socket.me.dtoObject)
        }
    }

    // use hit ok button on LogInView
    private onTryLoggingInEvent(socket: DomainSocket, name: string, color: RGBColor): void {
        if (socket.me) {
            // if this socket's player is already created, just return
            // could happen if user clicks ok button multiple times very fase
            return
        }

        const newPlayer = this.gameData.addPlayer(socket.id, name, color)
        socket.me = newPlayer

        ServerSocketEventsHelper.sendLoggedInEvent(socket, newPlayer.dtoObject)
    }

    // client sends keyboard input event at approx 60fps
    private onPlayerInputEvent(socket: DomainSocket, playerInput: PlayerInputDTO): void {
        if (socket.me) {
            socket.me.applyInput(playerInput)
        }
    }

    private gameUpdateLoop(): void {
        const gameData = this.gameData
        // game update logic happens here!
        gameData.update()

        // send game data to all connected sockets
        const gameDataDTO = gameData.dtoObject
        for (let socket of this.connectedSockets) {
            ServerSocketEventsHelper.sendGameDataEvent(socket, gameDataDTO)
        }

        // recursively call myself
        setTimeout(this.gameUpdateLoop, this.gameUpdateInterval)
    }

    // GameEventsHandler

    asteroidKilledPlayer(asteroid: ServerAsteroid, player: ServerPlayer): void {
        const gameData = this.gameData
        const killedPlayer = gameData.removePlayerById(player.id)
        if (killedPlayer) {
            // recycle all bullets fired by this killedPlayer
            gameData.recycleBulletsByFirerId(killedPlayer.id)

            const killedPlayerSocket = this.connectedSockets.find(socket => socket.id === killedPlayer.id)
            if (killedPlayerSocket) {
                killedPlayerSocket.me = null
                ServerSocketEventsHelper.sendKilledByAsteroidEvent(killedPlayerSocket, killedPlayer.dtoObject)
            }
        }

        // do damage to the asteroid
        gameData.breakAsteroid(asteroid)
    }

    bulletKilledAsteroid(bullet: ServerBullet, asteroid: ServerAsteroid): void {
        const gameData = this.gameData
        if (bullet.firerId) {
            const firer = gameData.getPlayerWithId(bullet.firerId)
            if (firer) {
                gameData.breakAsteroid(asteroid)
                firer.increaseAsteroidPoint()
            }
        }

        gameData.recycleBulletById(bullet.id)
    }

    bulletKilledPlayer(bullet: ServerBullet, player: ServerPlayer): void {
        const gameData = this.gameData
        if (bullet.firerId) {
            const firer = gameData.getPlayerWithId(bullet.firerId)
            if (firer) {
                const killedPlayer = gameData.removePlayerById(player.id)
                if (killedPlayer) {
                    gameData.recycleBulletsByFirerId(killedPlayer.id)

                    const killedPlayerSocket = this.connectedSockets.find(socket => socket.id === killedPlayer.id)
                    if (killedPlayerSocket) {
                        killedPlayerSocket.me = null
                        ServerSocketEventsHelper.sendKilledByPlayerEvent(killedPlayerSocket, firer.dtoObject, killedPlayer.dtoObject)
                    }

                    firer.increaseKillingPoint()
                }
            }
        }

        gameData.recycleBulletById(bullet.id)
    }

}

const server = new Server()
server.start(port)
