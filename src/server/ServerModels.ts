import {Socket} from "socket.io"
import {AsteroidDTO, BulletDTO, GameDataDTO, PlayerDTO, PlayerInputDTO} from "../shared/DTOs"
import {RGBColor} from "react-color"
import {Constants} from "../shared/Constants"
import Utils from "../shared/Utils"
import Victor = require("victor")
import uuid = require("uuid")

export interface DomainSocket extends Socket {
    me: ServerPlayer
}

export class ServerGameData {
    private readonly width: number = 4000
    private readonly height: number = 4000

    private readonly players: ServerPlayer[] = []
    private readonly bulletHouse: BulletHouse = new BulletHouse()
    private readonly asteroids: ServerAsteroid[] = []

    private readonly minBigAsteroidCount = 7
    private readonly bigAsteroidCountMultiplesOfPlayer = 3
    private curBigAsteroidsCount = 0

    readonly dtoObject: GameDataDTO

    constructor() {
        const w = this.width
        const h = this.height
        for (let i = 0; i < this.minBigAsteroidCount; i++) {
            this.asteroids.push(new ServerAsteroid(w, h, true))
            this.curBigAsteroidsCount++
        }

        this.dtoObject = {
            width: this.width,
            height: this.height,
            players: this.players.map(value => value.dtoObject),
            bullets: this.bulletHouse.bullets.map(bullet => bullet.dtoObject),
            asteroids: this.asteroids.map(value => value.dtoObject)
        }
    }

    update(): void {
        const width = this.width
        const height = this.height
        const players = this.players
        const bulletHouse = this.bulletHouse
        const asteroids = this.asteroids

        players.forEach(player => player.update(width, height))
        bulletHouse.update(width, height)

        for (let i = 0; i < asteroids.length; i++) {
            const asteroid = asteroids[i]
            asteroid.update(width, height)
            if (asteroid.needNewTarget) {
                if (asteroid.isBig) {
                    const randPlayer = Utils.pickRandom(this.players)
                    if (randPlayer) {
                        asteroid.setTarget(randPlayer.x, randPlayer.y)
                    } else {
                        asteroid.setTarget(Utils.randInt(0, width), Utils.randInt(0, height))
                    }
                } else {
                    asteroids.splice(i--, 1)
                }
            }
        }

        const dto = this.dtoObject
        dto.players = this.players.map(value => value.dtoObject)
        dto.bullets = this.bulletHouse.bullets.map(bullet => bullet.dtoObject)
        dto.asteroids = this.asteroids.map(value => value.dtoObject)
    }

    addPlayer(id: string, name: string, color: RGBColor): ServerPlayer {
        const newPlayer = new ServerPlayer(id, name, color, this.width / 2, this.height / 2,
            this.bulletHouse)
        this.players.push(newPlayer)
        return newPlayer
    }

    removePlayer(player: ServerPlayer): void {
        const index = this.players.findIndex(value => player.id === value.id)
        if (index >= 0) {
            this.players.splice(index, 1)
        }
    }
}

export class ServerPlayer {
    private static readonly maxSpeed = 8

    readonly id: string
    private readonly name: string
    private readonly color: RGBColor
    private readonly size: number = 15
    x: number
    y: number
    private heading: number = Constants.HALF_PI
    private readonly vertices: number[][] = []
    private showTail: boolean = false

    private readonly velocity = new Victor(0, 0)
    private readonly acceleration = new Victor(0, 0)
    private readonly boostingForce = new Victor(0, 0)
    private rotation = 0
    private isBoosting = false

    private isFiring = false
    private readonly fireInterval = 1000 / 4
    private now = 0
    private then = Date.now()
    private fireDelta = 0

    private readonly bulletHouse: BulletHouse

    readonly dtoObject: PlayerDTO

    constructor(id: string, name: string, color: RGBColor, x: number, y: number,
                bulletHouse: BulletHouse) {
        this.id = id
        this.name = name
        this.color = color
        this.x = x
        this.y = y

        const size = this.size
        this.vertices.push([-size, size], [size, size], [0, -size])

        this.bulletHouse = bulletHouse

        this.dtoObject = {
            id: this.id,
            name: this.name,
            color: this.color,
            x: this.x,
            y: this.y,
            size: this.size,
            heading: this.heading,
            vertices: this.vertices,
            showTail: this.showTail
        }
    }

    applyInput(input: PlayerInputDTO): void {
        this.isBoosting = input.up

        if (input.left) {
            this.rotation = -0.08
        } else if (input.right) {
            this.rotation = 0.08
        } else if (!input.left && !input.right) {
            this.rotation = 0
        }

        this.isFiring = input.fire
    }

    update(width: number, height: number): void {
        this.heading += this.rotation

        this.updateBoostingForce(this.isBoosting)
        this.acceleration.add(this.boostingForce)
        this.velocity.add(this.acceleration)
        if (this.velocity.magnitude() > ServerPlayer.maxSpeed) {
            this.velocity.norm().multiplyScalar(ServerPlayer.maxSpeed)
        }
        this.velocity.multiplyScalar(0.99)
        this.x += this.velocity.x
        this.y += this.velocity.y

        this.checkEdges(width, height)

        this.acceleration.multiplyScalar(0)

        if (this.isFiring) {
            this.now = Date.now()
            this.fireDelta = this.now - this.then
            if (this.fireDelta > this.fireInterval) {
                this.then = this.now

                this.bulletHouse.fireBullet(this.id, this.x, this.y, this.heading, this.color)
            }
        }

        this.showTail = this.velocity.magnitude() > 1

        const dto = this.dtoObject
        dto.x = this.x
        dto.y = this.y
        dto.heading = this.heading
        dto.showTail = this.showTail
    }

    private updateBoostingForce(isBoosting: boolean): void {
        if (isBoosting) {
            this.boostingForce.addScalar(1).rotateBy(this.heading + Constants.HALF_PI).normalize().multiplyScalar(0.1)
        } else {
            this.boostingForce.multiplyScalar(0)
        }
    }

    private checkEdges(width: number, height: number): void {
        const r = this.size

        if (this.x > width + r) {
            this.x = -r
        } else if (this.x < -r) {
            this.x = width + r
        }

        if (this.y > height + r) {
            this.y = -r
        } else if (this.y < -r) {
            this.y = height + r
        }
    }
}

class BulletHouse {
    private readonly recycledBullets: ServerBullet[] = []
    readonly bullets: ServerBullet[] = []

    fireBullet(firerId: string, x: number, y: number, heading: number, color: RGBColor): void {
        const bullet = this.createOrGetBullet()
        bullet.setInitValues(firerId, x, y, heading, color)
        this.bullets.push(bullet)
    }

    private createOrGetBullet(): ServerBullet {
        let bullet = this.recycledBullets.pop()
        if (!bullet) {
            bullet = new ServerBullet()
        }
        return bullet
    }

    update(width: number, height: number): void {
        const bullets = this.bullets
        const recycledBullets = this.recycledBullets
        let i = bullets.length
        while (i--) {
            const bullet = bullets[i]
            bullet.update(width, height)
            if (bullet.needsToBeRecycled) {
                bullet.prepareRecycle()
                recycledBullets.push(bullet)
                bullets.splice(i, 1)
            }
        }
    }

}

export class ServerBullet {
    private static readonly speed = 10

    private readonly id: string = uuid()
    private readonly maxSize: number = 5
    private readonly vertices: number[][] = [[0, -this.maxSize], [0, this.maxSize]]
    private x: number = 0
    private y: number = 0
    private heading: number = 0

    private firerId: string | null = null
    private readonly velocity = new Victor(0, 0)
    private color = { r: 255, g: 255, b: 255 }

    needsToBeRecycled = false

    readonly dtoObject: BulletDTO = {
        id: this.id,
        x: this.x,
        y: this.y,
        heading: this.heading,
        vertices: this.vertices,
        color: this.color
    }

    setInitValues(firerId: string, x: number, y: number, heading: number, color: RGBColor): void {
        this.firerId = firerId
        this.x = x
        this.y = y
        this.heading = heading
        this.velocity.addScalar(1).rotateBy(heading + Constants.HALF_PI).norm().multiplyScalar(ServerBullet.speed)
        this.color = color
    }

    update(width: number, height: number): void {
        this.x += this.velocity.x
        this.y += this.velocity.y

        const x = this.x
        const y = this.y
        if (!this.needsToBeRecycled) {
            this.needsToBeRecycled = x > width || x < 0 || y > height || y < 0
        }

        const dto = this.dtoObject
        dto.x = x
        dto.y = y
        dto.heading = this.heading
        dto.color = this.color
    }

    prepareRecycle(): void {
        this.x = -1000
        this.y = -1000
        this.heading = 0
        this.velocity.multiplyScalar(0)
        this.firerId = null
        this.needsToBeRecycled = false
    }

}

export class ServerAsteroid {
    static readonly vertexSize_big = 10
    static readonly vertexSize_small = 5

    readonly id: string = uuid()
    readonly maxSize: number
    readonly minSize: number
    readonly vertices: number[][] = []
    x!: number
    y!: number
    rotation: number = 0
    private readonly rotationSpeed: number
    private readonly velocity = new Victor(0, 0)
    private speed: number

    needNewTarget = true

    private readonly outsideThreshold = 50

    readonly isBig: boolean

    readonly dtoObject: AsteroidDTO

    constructor(width: number, height: number, isBig: boolean) {
        this.setRandomSpawnPoint(width, height)
        this.isBig = isBig

        if (isBig) {
            this.rotationSpeed = Utils.map(Math.random(), 0, 1, 0.01, 0.03)
            this.speed = Utils.map(Math.random(), 0, 1, 1, 2)
            this.maxSize = Utils.randInt(80, 100)
            this.minSize = Utils.randInt(40, 60)

            const vertexCount = ServerAsteroid.vertexSize_big
            for (let i = 0; i < vertexCount; i++) {
                const angle = Utils.map(i, 0, vertexCount, 0, Constants.TWO_PI)
                const r = Utils.randInt(this.minSize, this.maxSize)
                const x = r * Math.cos(angle)
                const y = r * Math.sin(angle)
                this.vertices.push([x, y])
            }
        } else {
            this.rotationSpeed = Utils.map(Math.random(), 0, 1, 0.05, 0.07)
            this.speed = Utils.map(Math.random(), 0, 1, 1.5, 2.5)
            this.maxSize = Utils.randInt(40, 60)
            this.minSize = Utils.randInt(10, 30)

            const vertexCount = ServerAsteroid.vertexSize_small
            for (let i = 0; i < vertexCount; i++) {
                const angle = Utils.map(i, 0, vertexCount, 0, Constants.TWO_PI)
                const r = Utils.randInt(this.minSize, this.maxSize)
                const x = r * Math.cos(angle)
                const y = r * Math.sin(angle)
                this.vertices.push([x, y])
            }
        }

        this.dtoObject = {
            id: this.id,
            x: this.x,
            y: this.y,
            rotation: this.rotation,
            vertices: this.vertices
        }
    }

    setTarget(x: number, y: number): void {
        if (this.isBig) {
            this.speed = Utils.map(Math.random(), 0, 1, 1, 2)
        } else {
            this.speed = Utils.map(Math.random(), 0, 1, 1.5, 2.5)
        }
        const v = new Victor(x, y).subtractScalarX(this.x).subtractScalarY(this.y).norm().multiplyScalar(this.speed)
        this.velocity.x = v.x
        this.velocity.y = v.y
        this.needNewTarget = false
    }

    private setRandomSpawnPoint(width: number, height: number) {
        const rand = Math.random()
        if (rand < 0.25) {
            this.x = Utils.randInt(-200, -100)
            this.y = Utils.randInt(0, height)
        } else if (rand < 0.5) {
            this.x = Utils.randInt(0, width)
            this.y = Utils.randInt(-200, -100)
        } else if (rand < 0.75) {
            this.x = Utils.randInt(width + 100, width + 200)
            this.y = Utils.randInt(0, height)
        } else {
            this.x = Utils.randInt(0, width)
            this.y = Utils.randInt(height + 100, height + 200)
        }
    }

    update(width: number, height: number): void {
        this.rotation += this.rotationSpeed
        this.x += this.velocity.x
        this.y += this.velocity.y

        const x = this.x
        const y = this.y
        const size = this.maxSize
        const outsideThreshold = this.outsideThreshold

        if (!this.needNewTarget) {
            this.needNewTarget = x - size > width + outsideThreshold || x + size < -outsideThreshold
                || y - size > height + outsideThreshold || y + size < -outsideThreshold
        }

        const dto = this.dtoObject
        dto.x = x
        dto.y = y
        dto.rotation = this.rotation
    }

}
