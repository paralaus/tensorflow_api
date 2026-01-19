'use strict';

const config = require('./config');
const Logger = require('./Logger');
const log = new Logger('Room');

const { audioLevelObserverEnabled, activeSpeakerObserverEnabled } = config.mediasoup.router;

module.exports = class Room {
    constructor(room_id, worker, io) {
        this.id = room_id;
        this.worker = worker;
        this.webRtcServer = worker.appData.webRtcServer;
        this.webRtcServerActive = config.mediasoup.webRtcServerActive;
        this.io = io;
        this.audioLevelObserver = null;
        this.audioLevelObserverEnabled = audioLevelObserverEnabled !== undefined ? audioLevelObserverEnabled : true;
        this.audioLastUpdateTime = 0;
        this.activeSpeakerObserverEnabled =
            activeSpeakerObserverEnabled !== undefined ? activeSpeakerObserverEnabled : false;
        this.activeSpeakerObserver = null;
        // ##########################
        this._isBroadcasting = false;
        // ##########################
        this._isLocked = false;
        this._isLobbyEnabled = false;
        this._roomPassword = null;
        this._hostOnlyRecording = false;
        // ##########################
        this.recording = {
            recSyncServerRecording: config?.server?.recording?.enabled || false,
            recSyncServerEndpoint: config?.server?.recording?.endpoint || '',
        };
        // ##########################
        this._moderator = {
            audio_start_muted: false,
            video_start_hidden: false,
            audio_cant_unmute: false,
            video_cant_unhide: false,
            screen_cant_share: false,
            chat_cant_privately: false,
            chat_cant_chatgpt: false,
        };
        this.survey = config.survey;
        this.redirect = config.redirect;
        this.videoAIEnabled = config?.videoAI?.enabled || false;
        this.peers = new Map();
        this.bannedPeers = [];
        this.webRtcTransport = config.mediasoup.webRtcTransport;
        this.router = null;
        this.routerSettings = config.mediasoup.router;
        this.createTheRouter();
    }

    // ####################################################
    // ODA BİLGİSİ
    // ####################################################

    toJson() {
        return {
            id: this.id,
            broadcasting: this._isBroadcasting,
            recording: this.recording,
            config: {
                isLocked: this._isLocked,
                isLobbyEnabled: this._isLobbyEnabled,
                hostOnlyRecording: this._hostOnlyRecording,
            },
            moderator: this._moderator,
            survey: this.survey,
            redirect: this.redirect,
            videoAIEnabled: this.videoAIEnabled,
            peers: JSON.stringify([...this.peers]),
        };
    }

    // ####################################################
    // YÖNLENDİRİCİ
    // ####################################################

    createTheRouter() {
        const { mediaCodecs } = this.routerSettings;
        this.worker
            .createRouter({
                mediaCodecs,
            })
            .then((router) => {
                this.router = router;
                if (this.audioLevelObserverEnabled) {
                    this.startAudioLevelObservation();
                }
                if (this.activeSpeakerObserverEnabled) {
                    this.startActiveSpeakerObserver();
                }
                this.router.observer.on('close', () => {
                    log.info('---------------> Son katılımcı odadan ayrıldığından yönlendirici artık kapalı', {
                        room: this.id,
                    });
                });
            });
    }

    getRtpCapabilities() {
        return this.router.rtpCapabilities;
    }

    closeRouter() {
        this.router.close();
        log.debug('Oda yönlendiricisini kapat', {
            router_id: this.router.id,
            router_closed: this.router.closed,
        });
    }

    // ####################################################
    // ÜRETİCİ SES SEVİYESİ GÖZLEMCİSİ
    // ####################################################

    async startAudioLevelObservation() {
        log.debug('Aktif konuşmacının sinyalini vermek için audioLevelObserver ı başlatın...');

        this.audioLevelObserver = await this.router.createAudioLevelObserver({
            maxEntries: 1,
            threshold: -70,
            interval: 100,
        });

        this.audioLevelObserver.on('volumes', (volumes) => {
            this.sendActiveSpeakerVolume(volumes);
        });
        this.audioLevelObserver.on('silence', () => {
            //log.debug('audioLevelObserver', { volume: 'silence' });
        });
    }

    sendActiveSpeakerVolume(volumes) {
        try {
            if (!Array.isArray(volumes) || volumes.length === 0) {
                throw new Error('Geçersiz birim dizisi');
            }

            if (Date.now() > this.audioLastUpdateTime + 100) {
                this.audioLastUpdateTime = Date.now();

                const { producer, volume } = volumes[0];
                const audioVolume = Math.round(Math.pow(10, volume / 70) * 10); // Sesi 1-10'a ölçeklendir

                if (audioVolume > 1) {
                    this.peers.forEach((peer) => {
                        const { id, peer_audio, peer_name } = peer;
                        peer.producers.forEach((peerProducer) => {
                            if (peerProducer.id === producer.id && peerProducer.kind === 'audio' && peer_audio) {
                                const data = {
                                    peer_id: id,
                                    peer_name: peer_name,
                                    audioVolume: audioVolume,
                                };
                                // Hata ayıklama için aşağıdaki satırın açıklamasını kaldırın
                                // log.debug('Ses seviyesi gönderiliyor', data);
                                this.sendToAll('audioVolume', data);
                            }
                        });
                    });
                }
            }
        } catch (error) {
            log.error('Aktif hoparlör sesi gönderilirken hata oluştu', error.message);
        }
    }

    addProducerToAudioLevelObserver(producer) {
        if (this.audioLevelObserverEnabled) {
            this.audioLevelObserver.addProducer(producer);
        }
    }

    // ####################################################
    // ÜRETİCİ BASKIN AKTİF KONUŞMACI
    // ####################################################

    async startActiveSpeakerObserver() {
        this.activeSpeakerObserver = await this.router.createActiveSpeakerObserver();
        this.activeSpeakerObserver.on('dominantspeaker', (dominantSpeaker) => {
            log.debug('activeSpeakerObserver "dominantspeaker" event', dominantSpeaker.producer.id);
            this.peers.forEach((peer) => {
                const { id, peer_audio, peer_name } = peer;
                peer.producers.forEach((peerProducer) => {
                    if (
                        peerProducer.id === dominantSpeaker.producer.id &&
                        peerProducer.kind === 'audio' &&
                        peer_audio
                    ) {
                        const data = {
                            peer_id: id,
                            peer_name: peer_name,
                        };
                        // log.debug('Sending dominant speaker', data);
                        this.sendToAll('dominantSpeaker', data);
                    }
                });
            });
        });
    }

    addProducerToActiveSpeakerObserver(producer) {
        if (this.activeSpeakerObserverEnabled) {
            this.activeSpeakerObserver.addProducer(producer);
        }
    }

    // ####################################################
    // ODA MODERATÖRÜ
    // ####################################################

    updateRoomModeratorALL(data) {
        this._moderator = data;
        log.debug('Oda moderatörünün tüm verilerini güncelle', this._moderator);
    }

    updateRoomModerator(data) {
        log.debug('Oda moderatörünü güncelle', data);
        switch (data.type) {
            case 'audio_start_muted':
                this._moderator.audio_start_muted = data.status;
                break;
            case 'video_start_hidden':
                this._moderator.video_start_hidden = data.status;
                break;
            case 'audio_cant_unmute':
                this._moderator.audio_cant_unmute = data.status;
                break;
            case 'video_cant_unhide':
                this._moderator.video_cant_unhide = data.status;
                break;
            case 'screen_cant_share':
                this._moderator.screen_cant_share = data.status;
                break;
            case 'chat_cant_privately':
                this._moderator.chat_cant_privately = data.status;
                break;
            case 'chat_cant_chatgpt':
                this._moderator.chat_cant_chatgpt = data.status;
                break;
            default:
                break;
        }
    }

    // ####################################################
    // KATILIMCILAR
    // ####################################################

    addPeer(peer) {
        this.peers.set(peer.id, peer);
    }

    getPeer(socket_id) {
        if (!this.peers.has(socket_id)) return;

        const peer = this.peers.get(socket_id);

        return peer;
    }

    getPeers() {
        return this.peers;
    }

    getPeersCount() {
        return this.peers.size;
    }

    getProducerListForPeer() {
        const producerList = [];
        this.peers.forEach((peer) => {
            const { peer_name, peer_info } = peer;
            peer.producers.forEach((producer) => {
                producerList.push({
                    producer_id: producer.id,
                    peer_name: peer_name,
                    peer_info: peer_info,
                    type: producer.appData.mediaType,
                });
            });
        });
        return producerList;
    }

    async removePeer(socket_id) {
        if (!this.peers.has(socket_id)) return;

        const peer = this.getPeer(socket_id);

        peer.close();

        this.peers.delete(socket_id);

        if (this.getPeers().size === 0) {
            this.closeRouter();
        }
    }

    // ####################################################
    // WebRTC AKTARIM
    // ####################################################

    async createWebRtcTransport(socket_id) {
        if (!this.peers.has(socket_id)) return;

        const { maxIncomingBitrate, initialAvailableOutgoingBitrate, listenInfos } = this.webRtcTransport;

        const webRtcTransportOptions = {
            ...(this.webRtcServerActive ? { webRtcServer: this.webRtcServer } : { listenInfos: listenInfos }),
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            iceConsentTimeout: 20,
            initialAvailableOutgoingBitrate,
        };

        log.debug('webRtcTransportOptions ----->', webRtcTransportOptions);

        const transport = await this.router.createWebRtcTransport(webRtcTransportOptions);

        if (!transport) {
            throw new Error('WebRtc Aktarımı oluşturulamadı!');
        }

        const { id, iceParameters, iceCandidates, dtlsParameters } = transport;

        if (maxIncomingBitrate) {
            try {
                await transport.setMaxIncomingBitrate(maxIncomingBitrate);
            } catch (error) {}
        }

        const peer = this.getPeer(socket_id);

        peer.addTransport(transport);

        log.debug('Aktarım oluşturuldu', { transportId: id });

        const { peer_name } = peer;

        transport.on('icestatechange', (iceState) => {
            if (iceState === 'disconnected' || iceState === 'closed') {
                log.debug('Aktarım "icestatechange" etkinliğini kapattı', {
                    peer_name: peer_name,
                    transport_id: id,
                    iceState: iceState,
                });
                transport.close();
            }
        });

        transport.on('sctpstatechange', (sctpState) => {
            log.debug('Aktarım "sctpstatechange" olayı', {
                peer_name: peer_name,
                transport_id: id,
                sctpState: sctpState,
            });
        });

        transport.on('dtlsstatechange', (dtlsState) => {
            if (dtlsState === 'failed' || dtlsState === 'closed') {
                log.debug('Aktarım "dtlsstatechange" etkinliğini kapattı', {
                    peer_name: peer_name,
                    transport_id: id,
                    dtlsState: dtlsState,
                });
                transport.close();
            }
        });

        transport.on('close', () => {
            log.debug('Aktarım kapatıldı', {
                peer_name: peer_name,
                transport_id: transport.id,
            });
        });

        return {
            id: id,
            iceParameters: iceParameters,
            iceCandidates: iceCandidates,
            dtlsParameters: dtlsParameters,
        };
    }

    async connectPeerTransport(socket_id, transport_id, dtlsParameters) {
        if (!this.peers.has(socket_id)) return;

        const peer = this.getPeer(socket_id);

        await peer.connectTransport(transport_id, dtlsParameters);

        return '[Room|connectPeerTransport] done';
    }

    // ####################################################
    // ÜRETİM
    // ####################################################

    async produce(socket_id, producerTransportId, rtpParameters, kind, type) {
        if (!this.peers.has(socket_id)) return;

        const peer = this.getPeer(socket_id);

        const peerProducer = await peer.createProducer(producerTransportId, rtpParameters, kind, type);

        if (!peerProducer) {
            throw new Error(`${producerTransportId} kimliğine sahip katılımcı üretici türü ${kind} bulunamadı`);
        }

        const { id } = peerProducer;

        const { peer_name, peer_info } = peer;

        this.broadCast(socket_id, 'newProducers', [
            {
                producer_id: id,
                producer_socket_id: socket_id,
                peer_name: peer_name,
                peer_info: peer_info,
                type: type,
            },
        ]);

        return id;
    }

    closeProducer(socket_id, producer_id) {
        if (!this.peers.has(socket_id)) return;

        const peer = this.getPeer(socket_id);

        peer.closeProducer(producer_id);
    }

    // ####################################################
    // TÜKETİM
    // ####################################################

    async consume(socket_id, consumer_transport_id, producer_id, rtpCapabilities) {
        if (!this.peers.has(socket_id)) return;

        if (
            !this.router.canConsume({
                producerId: producer_id,
                rtpCapabilities,
            })
        ) {
            log.warn('Tüketilemez', {
                socket_id,
                consumer_transport_id,
                producer_id,
            });
            return;
        }

        const peer = this.getPeer(socket_id);

        const peerConsumer = await peer.createConsumer(consumer_transport_id, producer_id, rtpCapabilities);

        if (!peerConsumer) {
            throw new Error(`${consumer_transport_id} kimliğine sahip ${kind} eş tüketici türü bulunamadı`);
        }

        const { consumer, params } = peerConsumer;

        const { id, kind } = consumer;

        consumer.on('producerclose', () => {
            log.debug('Tüketici "producerclose" olayı nedeniyle kapatıldı');

            peer.removeConsumer(id);

            // Client'e tüketicinin kapalı olduğunu bildirin
            this.send(socket_id, 'consumerClosed', {
                consumer_id: id,
                consumer_kind: kind,
            });
        });

        return params;
    }

    // ####################################################
    // YASAKLANAN KATILIMCILARI YÖNET
    // ####################################################

    addBannedPeer(uuid) {
        if (!this.bannedPeers.includes(uuid)) {
            this.bannedPeers.push(uuid);
            log.debug('Yasaklananlar listesine eklendi', {
                uuid: uuid,
                banned: this.bannedPeers,
            });
        }
    }

    isBanned(uuid) {
        return this.bannedPeers.includes(uuid);
    }

    // ####################################################
    // ODA DURUMU
    // ####################################################

    // GETİR
    isBroadcasting() {
        return this._isBroadcasting;
    }
    getPassword() {
        return this._roomPassword;
    }

    // BOOL
    isLocked() {
        return this._isLocked;
    }
    isLobbyEnabled() {
        return this._isLobbyEnabled;
    }
    isHostOnlyRecording() {
        return this._hostOnlyRecording;
    }

    // AYARLA
    setIsBroadcasting(status) {
        this._isBroadcasting = status;
    }
    setLocked(status, password) {
        this._isLocked = status;
        this._roomPassword = password;
    }
    setLobbyEnabled(status) {
        this._isLobbyEnabled = status;
    }
    setHostOnlyRecording(status) {
        this._hostOnlyRecording = status;
    }

    // ####################################################
    // GÖNDERİCİ
    // ####################################################

    broadCast(socket_id, action, data) {
        for (let otherID of Array.from(this.peers.keys()).filter((id) => id !== socket_id)) {
            this.send(otherID, action, data);
        }
    }

    sendTo(socket_id, action, data) {
        for (let peer_id of Array.from(this.peers.keys()).filter((id) => id === socket_id)) {
            this.send(peer_id, action, data);
        }
    }

    sendToAll(action, data) {
        for (let peer_id of Array.from(this.peers.keys())) {
            this.send(peer_id, action, data);
        }
    }

    send(socket_id, action, data) {
        this.io.to(socket_id).emit(action, data);
    }
};
