import * as express from 'express';
import {Application, Request, Response} from 'express';
import * as Dockerode from 'dockerode';
import {Container} from 'dockerode';
import {RESPONSE_MESSAGE} from '../../constant/Constants';
import {Region} from '../../entities/Region';
import {History} from '../../entities/History';
import {Image} from '../../entities/Image';
import {Model} from '../../entities/Model';
import {HTTPService} from '../interfaces/http/HTTPService';
import {Server} from 'http';
import {DockerUtils} from '../../utils/DockerUtils';
import * as multer from 'multer';
import {MulterUtils} from '../../utils/MulterUtils';
import {HistoryStatus} from '../../types/chameleon-platform.enum';
import PlatformServer from '../../server/core/PlatformServer';
import {User} from '../../entities/User';
import {HTTPLogUtils} from '../../utils/HTTPLogUtils';

const images = multer({fileFilter: MulterUtils.fixNameEncoding, dest: 'uploads/images'});
const inputs = multer({fileFilter: MulterUtils.fixNameEncoding, dest: 'uploads/inputs'});

export class ModelService extends HTTPService {
    private containerCachingLock = new Map<number, boolean>();

    init(app: Application, server: Server) {
        const router = express.Router();
        router.post('/upload', images.single('file'), HTTPLogUtils.addBeginLogger(this.handleUpload, 'Model:upload'));
        router.post('/execute', inputs.single('input'), HTTPLogUtils.addBeginLogger(this.handleExecute, 'Model:execute'));
        router.get('/list', HTTPLogUtils.addBeginLogger(this.handleList, 'Model:list'));
        router.get('/new-list', HTTPLogUtils.addBeginLogger(this.handleNewList, 'Model:new-list'));
        router.get('/info', HTTPLogUtils.addBeginLogger(this.handleInfo, 'Model:info'));
        router.put('/update', HTTPLogUtils.addBeginLogger(this.handleUpdate, 'Model:update'));
        app.use('/model', router);
    }

    async handleExecute(req: Request, res: Response, next: Function) {
        if (!req.isAuthenticated()) res.status(401).send(RESPONSE_MESSAGE.NOT_AUTH);
        const {parameters: rawParameters, modelId} = req.body;
        if (!(rawParameters && modelId && req.file)) return res.status(501).send(RESPONSE_MESSAGE.NON_FIELD);
        const parameters = JSON.parse(rawParameters);
        const user: User = req.user as User;
        const model: Model = await this.modelController.findById(modelId);

        if (!model) return res.status(401).send({...RESPONSE_MESSAGE.WRONG_INFO, reason: 'Model does not exist.'});

        setTimeout(async _ => {
            const image = model.image;
            const region = model.image.region;
            const docker = new Dockerode(region);
            const file = req.file;

            let history: History;
            let container: Container;

            const cachedHistory = await this.historyController.findAndUseCache(image);
            if (cachedHistory) {
                console.log(`[${model.name}] Found cached containers`);
                history = cachedHistory;
                container = await docker.getContainer(history.containerId);
                await container.restart();
            } else {
                console.log(`[${model.name}] No cached containers`);
                const {
                    history: newHistory,
                    container: newContainer
                } = await this.createCachedContainer(docker, model, true);
                history = newHistory;
                container = newContainer;
            }

            history.startedTime = new Date();
            history.executor = user;
            history.status = HistoryStatus.INITIALIZING;
            history.inputPath = file.path;
            history.inputInfo = {originalName: file.originalname, size: file.size, mimeType: file.mimetype};
            history.parameters = parameters;
            await this.historyController.save(history);
            // TODO: TIMING - INITIALIZING
            let targetSockets = PlatformServer.wsServer.manager.getHistoryRelatedSockets(history, PlatformServer.wsServer.manager.getAuthenticatedSockets());
            PlatformServer.wsServer.manager.sendUpdateHistory(history, targetSockets);
            // PlatformServer.wsServer.manager.
            // targetSockets

            setTimeout(() => this.createCachedContainers(docker, model));
            const {paths} = history.model.config;
            const port = PlatformServer.config.socketExternalPort ? PlatformServer.config.socketExternalPort : PlatformServer.config.socketPort;

            setTimeout(() =>
                DockerUtils.exec(container, `chmod 777 "${paths.controllerDirectory}/controller" && "${paths.controllerDirectory}/controller" ${PlatformServer.config.socketExternalHost} ${port} ${history.id} >> ${paths.debugLog} 2>&1`)
            );

            history.status = HistoryStatus.RUNNING;
            history.startedTime = new Date();
            await this.historyController.save(history);
            // TODO: TIMING - RUNNING
            targetSockets = PlatformServer.wsServer.manager.getHistoryRelatedSockets(history, PlatformServer.wsServer.manager.getAuthenticatedSockets());
            PlatformServer.wsServer.manager.sendUpdateHistory(history, targetSockets);
        });

        return res.status(200).send({msg: 'ok'});
    }

    async handleList(req: Request, res: Response, next: Function) {
        if (!req.isAuthenticated()) return res.status(401).send(RESPONSE_MESSAGE.NOT_AUTH);
        const models = await this.modelController.getAll();
        const responseData = models.map((model) => [
            'id',
            'updatedTime',
            'uniqueName',
            'name',
            'inputType',
            'outputType'
        ].reduce((obj, key) => ({...obj, [key]: model[key]}), {
            username: model.register.username,
            modelName: model.name,
            regionName: model.image.region.name
        }));
        return res.status(200).send(responseData);
    }

    async handleNewList(req: Request, res: Response, next: Function) {
        if (!req.isAuthenticated()) return res.status(401).send(RESPONSE_MESSAGE.NOT_AUTH);
        const responseData = (await this.modelController.getAll()).map(m => m.toData());
        return res.status(200).send(responseData);
    }

    // TODO: newList로 마이그레이션
    async handleInfo(req: Request, res: Response, next: Function) {
        if (!req.isAuthenticated()) return res.status(401).send(RESPONSE_MESSAGE.NOT_AUTH);
        const {uniqueName: inputUniqueName} = req.body;
        if (!inputUniqueName) return res.status(401).send(RESPONSE_MESSAGE.NON_FIELD);
        try {
            const modelResult = await this.modelController.findModelByUniqueName(inputUniqueName);
            if (!modelResult) return res.status(404).send(RESPONSE_MESSAGE.NOT_FOUND);
            const response = [
                'id',
                'createdTime',
                'updatedTime',
                'uniqueName',
                'description',
                'name',
                'inputType',
                'outputType',
                'parameter'
            ].reduce((obj, key) => ({...obj, [key]: modelResult[key]}), {
                username: modelResult.register.username,
                modelName: modelResult.name,
                regionName: modelResult.image.region.name
            });
            return res.status(200).send(response);
        } catch (e) {
            return res.status(501).send(RESPONSE_MESSAGE.SERVER_ERROR);
        }
    }

    // TODO: 구조 개선
    async handleUpdate(req: Request, res: Response, next: Function) {
        const {modelId, repository, modelName, description, inputType, outputType} = req.body;

        if (!(modelId && repository && modelName && description && inputType && outputType))
            return res.status(401).send(RESPONSE_MESSAGE.NON_FIELD);
        try {
            const prevModel = await this.modelController.findById(modelId);
            prevModel.name = modelName;
            prevModel.inputType = inputType;
            prevModel.outputType = outputType;
            prevModel.description = description;
            prevModel.image.repository = repository;
            await this.modelController.save(prevModel);
            // await this.modelController.updateModel(modelId, {name: modelName, inputType, outputType, description});
            // await this.imageController.updateImage(prevModel.image.id, {repository});
        } catch (e) {
            return res.status(501).send(RESPONSE_MESSAGE.SERVER_ERROR);
        }

        return res.status(200).send(RESPONSE_MESSAGE.OK);
    }

    async deleteModel(req: Request, res: Response, next: Function) {
        const {modelId, imageId} = req.body;

        if (!(modelId && imageId)) return res.status(401).send(RESPONSE_MESSAGE.NON_FIELD);
        if (!req.isAuthenticated()) return res.status(401).send(RESPONSE_MESSAGE.NOT_AUTH);

        try {
            await this.modelController.deleteById(modelId);
            await this.imageController.deleteById(imageId);
        } catch (e) {
            return res.status(501).send(RESPONSE_MESSAGE.SERVER_ERROR);
        }

        return res.status(200).send(RESPONSE_MESSAGE.OK);
    }

    async toPermalink(repository: string, tag: string) {
        const tagName = tag.toLowerCase().replace(/ /g, '-');
        const repositoryName = repository.toLowerCase();
        const result = await this.imageController.findAllImageByRepositoryAndTagLike(repositoryName, tagName);

        if (result.length == 0) {
            return tagName;
        } else {
            const lastIndex = await this.getLastIndex(repositoryName, tagName);
            return `${tagName}-${lastIndex + 1}`;
        }
    }

    // TODO: 함수 2개 요약 필요 getLastIndex, toPermalink
    async getLastIndex(repository: string, tag: string) {
        const imageList = await this.imageController.findAllImageByRepositoryAndTagLike(repository, tag);
        const lastImage = imageList[imageList.length - 1];
        if (tag.length == lastImage.tag.length) return 0;
        else {
            const newTag = lastImage.tag;
            const result = newTag.slice(tag.length + 1, newTag.length);
            return result ? parseInt(result) : 0;
        }
    }

    async addControllerToContainer(container: Container, model: Model) {
        const config = model.config;
        const {paths} = config;

        const excludePaths = [paths.script, paths.controllerDirectory, '/dev/null'];
        const clearPaths = Object.values(paths).filter(p => !excludePaths.includes(p)).sort();
        const initCommand = [`mkdir -p ${paths.controllerDirectory}`, ...clearPaths.map(p => `rm -rf "${p}" && mkdir -p $(dirname "${p}")`)].join(' && ');
        await DockerUtils.exec(container, initCommand);

        const dependencies = container.putArchive(PlatformServer.config.dependenciesPath, {path: '/'});
        const controller = container.putArchive(PlatformServer.config.controllerPath, {path: paths.controllerDirectory});
        await Promise.all([dependencies, container]);
    }

    async createCachedContainer(docker: Dockerode, model: Model, keepRunning?: boolean) {
        const container = await docker.createContainer({
            Image: model.image.uniqueId,
            Tty: true
        });
        const history = new History();
        history.containerId = container.id;
        history.status = HistoryStatus.CACHED;
        history.model = model;

        await container.start();
        await this.addControllerToContainer(container, model);
        if (!keepRunning) {
            await container.stop();
        }
        await this.historyController.save(history);
        return {history, container};
    }

    async createCachedContainers(docker: Dockerode, model: Model) {
        if (!this.containerCachingLock.get(model.id)) {
            this.containerCachingLock.set(model.id, true);
            const cachedSize = (await this.historyController.findAllByImageAndStatus(model.image, HistoryStatus.CACHED)).length;
            const generateSize = model.cacheSize - cachedSize;
            console.log(`[${model.name}] Start creating ${generateSize} cached containers`);
            const tasks = Array.from({length: model.cacheSize - cachedSize}, () => this.createCachedContainer(docker, model));
            await Promise.all(tasks);
            console.log(`[${model.name}] End creating ${generateSize} cached containers`);
            this.containerCachingLock.set(model.id, false);
        }
    }

    async handleUpload(req: Request, res: Response, next: Function) {
        const {regionName, modelName, description, inputType, outputType, parameters} = req.body;
        if (!(regionName && modelName && description && inputType && outputType && req.file && parameters)) return res.status(501).send(RESPONSE_MESSAGE.NON_FIELD);
        if (!(req.isAuthenticated())) return res.status(501).send(RESPONSE_MESSAGE.NOT_AUTH);

        const region: Region = await this.regionController.findRegionByName(regionName);
        if (!region) return res.status(501).send(RESPONSE_MESSAGE.REG_NOT_FOUND);

        const file = req.file;
        const docker = new Dockerode(region);
        const image: Image = new Image();
        const username = req.user['username'].toLowerCase();
        const imageTag = await this.toPermalink(username, modelName);

        try {
            await DockerUtils.loadImage(docker, file.path, {repo: username, tag: imageTag});
        } catch (e) {
            console.error(e);
            res.status(501).send({...RESPONSE_MESSAGE.WRONG_INFO, reason: 'Wrong image file.'});
        }

        image.repository = req.user['username'].toLowerCase();
        image.tag = imageTag;
        const insertedImage = await docker.getImage(username + ':' + imageTag);
        image.uniqueId = (await insertedImage.inspect()).Id;
        image.region = region;
        image.path = file.path;

        const model: Model = new Model();
        model.name = modelName;
        model.description = description;
        model.inputType = inputType;
        model.outputType = outputType;
        model.image = await this.imageController.save(image);
        model.cacheSize = region.cacheSize;
        model.config = {
            paths: {
                script: '/opt/mctr/run',
                input: '/opt/mctr/i/raw',
                inputInfo: '/opt/mctr/i/info',
                parameters: '/opt/mctr/i/params',
                output: '/opt/mctr/o/raw',
                outputInfo: '/opt/mctr/o/info',
                outputDescription: '/opt/mctr/o/desc',
                controllerDirectory: '/opt/mctr/',
                debugLog: '/dev/null'
            }
        };
        // model-executor의 model configuration 기능 migration
        // TODO: 여유가 있다면 프론트에서 해당 뷰를 만들어야 함, 후순위
        model.parameters = JSON.parse(parameters);

        model.register = req.user as User;
        model.uniqueName = imageTag;
        await this.modelController.save(model);

        setTimeout(() => this.createCachedContainers(docker, model));
        return res.status(200).send(RESPONSE_MESSAGE.OK);
    }
}