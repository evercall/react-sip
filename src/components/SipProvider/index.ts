import * as PropTypes from 'prop-types';
import * as React from 'react';
import * as JsSIP from 'jssip';
import * as EventEmitter from 'eventemitter3';
import { UnRegisterOptions } from 'jssip/lib/UA';
import { MediaEngine } from '../../medialib/mediaengine'
import dummyLogger from '../../lib/dummyLogger';
import { SipUAConfig, SipExtraHeaders } from '../../siplib/sipua';
import { DtmfOptions, SipCall, SipCallConfig } from "../../siplib/sipcall";
import {
  LINE_STATUS_CONNECTED,
  LINE_STATUS_CONNECTING,
  LINE_STATUS_DISCONNECTED,
  SIP_STATUS_ERROR,
  SIP_STATUS_REGISTERED,
  SIP_STATUS_UNREGISTERED,
  SIP_ERROR_TYPE_NONE,
  SIP_ERROR_TYPE_CONFIGURATION,
  SIP_ERROR_TYPE_CONNECTION,
  SIP_ERROR_TYPE_REGISTRATION,
  SipErrorType,
  SipStatus,
  LineStatus,
} from '../../lib/enums';
import {
  extraHeadersPropType,
  iceServersPropType,
  Logger,
  sipPropType,
  callInfoListPropType,
} from '../../lib/types';
import { DTMF_TRANSPORT } from "jssip/lib/Constants";

export interface JsSipConfig {
  socket: string;
  // TODO: sockets[]
  user: string;
  uri: string;
  password: string;
  realm: string;
  host: string;
  port: number;
  pathname: string;
  secure: boolean;
  autoRegister: boolean;
  autoAnswer: boolean;
  iceRestart: boolean;
  sessionTimersExpires: number;
  extraHeaders: SipExtraHeaders;
  iceServers: RTCIceServer[];
  maxAllowedCalls: number;
  debug: boolean;
  debugNamespaces?: string | null;
  registrar?: string;
  // TODO: Phone event handlers
}

export interface JsSipState {
  lineStatus: LineStatus;
  sipStatus: SipStatus;
  errorType: SipErrorType;
  errorMessage: string;
  callList: SipCall[];
  callHistory: SipCall[];
}

export default class SipProvider extends React.Component<JsSipConfig, JsSipState> {
  static childContextTypes = {
    sip: sipPropType,
    calls: callInfoListPropType,
    callHistory: callInfoListPropType,
    // Status
    isLineConnected: PropTypes.func,
    isRegistered: PropTypes.func,
    hasError: PropTypes.func,
    getErrorMessage: PropTypes.func,
    // REGISTER
    registerSip: PropTypes.func,
    unregisterSip: PropTypes.func,
    // CALL
    makeCall: PropTypes.func,
  };

  static propTypes = {
    socket: PropTypes.string,
    user: PropTypes.string,
    uri: PropTypes.string,
    password: PropTypes.string,
    realm: PropTypes.string,
    // port: PropTypes.number,
    // pathname: PropTypes.string,
    secure: PropTypes.bool,
    autoRegister: PropTypes.bool,
    autoAnswer: PropTypes.bool,
    iceRestart: PropTypes.bool,
    sessionTimersExpires: PropTypes.number,
    extraHeaders: extraHeadersPropType,
    iceServers: iceServersPropType,
    maxAllowedCalls: PropTypes.number,
    debug: PropTypes.bool,
    registrar: PropTypes.string,
    children: PropTypes.node,
  };

  static defaultProps = {
    host: null,
    port: null,
    pathname: '',
    secure: true,
    user: null,
    password: null,
    autoRegister: true,
    autoAnswer: false,
    iceRestart: false,
    sessionTimersExpires: 120,
    maxAllowedCalls: 4,
    extraHeaders: {
      register: [],
      invite: [],
      nonInvite: [],
      info: [],
      refer: [],
      resp2xx: [],
      resp4xx: [],
    },
    iceServers: [],
    debug: false,
    children: null,
  };
  // TODO: Move UA logic to siplib
  private ua: JsSIP.UA | null = null;
  private logger: Logger;
  private localAddr: string;
  // @ts-ignore
  private isPlaying = false;
  private mediaEngine: MediaEngine;
  // @ts-ignore
  private uaConfig: SipUAConfig | null = null;
  private callConfig: SipCallConfig;
  private rtcConfig: RTCConfiguration;
  private dtmfOptions: DtmfOptions;
  private eventBus: EventEmitter;

  constructor(props) {
    super(props);
    // console.log('reactsip: constructor Sipprovider');
    this.state = {
      lineStatus: LINE_STATUS_DISCONNECTED,
      sipStatus: SIP_STATUS_UNREGISTERED,
      errorType: SIP_ERROR_TYPE_NONE,
      errorMessage: '',
      callList: [],
      callHistory: [],
    };
    this.ua = null;
    this.eventBus = new EventEmitter();
  }

  getChildContext() {
    return {
      sip: {
        ...this.props,
        addr: this.localAddr,
        status: this.state.sipStatus,
        errorType: this.state.errorType,
        errorMessage: this.state.errorMessage,
      },
      calls: [...this.state.callList],
      callHistory: [...this.state.callHistory],
      isLineConnected: this.isLineConnected.bind(this),
      isRegistered: this.isRegistered.bind(this),
      hasError: this.hasError.bind(this),
      getErrorMessage: this.getErrorMessage.bind(this),
      registerSip: this.registerSip.bind(this),
      unregisterSip: this.unregisterSip.bind(this),
      // CALL RELATED
      makeCall: this.makeCall.bind(this),
    };
  }

  initProperties = (): void => {
    this.uaConfig = {
      host: this.props.host,
      sessionTimers: true,
      registerExpires: 600,
      // registrar: this.props.registrar,
      userAgent: 'CioPhone UA v0.1', // Change this to one from props
    };
    // initialize sip call config
    this.callConfig = {
      extraHeaders: this.props.extraHeaders,
      sessionTimerExpires: this.props.sessionTimersExpires,
    };
    // initialize RTC config
    this.rtcConfig = {
      iceServers: this.props.iceServers,
    };
    // initialize DTMF
    this.dtmfOptions = {
      duration: 100,
      interToneGap: 500,
      channelType: DTMF_TRANSPORT.RFC2833, // INFO based ??
    };
    // initialize the media engine
    this.mediaEngine = new MediaEngine(null);
  };
  getCallConfig = (): SipCallConfig => {
    return this.callConfig;
  };
  getRTCConfig = (): RTCConfiguration => {
    return this.rtcConfig;
  };
  getDtmfOptions = (): DtmfOptions => {
    return this.dtmfOptions;
  };
  /**
   * Get the underlying UserAgent from JsSIP
   */
  getUA = (): JsSIP.UA | null => {
    return this.ua;
  };
  getUAOrFail = (): JsSIP.UA => {
    const ua = this.getUA();
    if (!ua) {
      throw new Error('JsSIP.UA not initialized');
    }
    return ua;
  };

  componentDidMount(): void {
    if (window.document.getElementById('sip-provider-audio')) {
      throw new Error(
        `Creating two SipProviders in one application is forbidden. If that's not the case ` +
          `then check if you're using "sip-provider-audio" as id attribute for any existing ` +
          `element`,
      );
    }
    this.reconfigureDebug();
    this.initProperties();
    this.reinitializeJsSIP();
    // TODO: reinitialize media device here
  }

  componentDidUpdate(prevProps): void {
    if (this.props.debug !== prevProps.debug) {
      this.reconfigureDebug();
    }
    if (
      this.props.socket !== prevProps.socket ||
      this.props.host !== prevProps.host ||
      this.props.port !== prevProps.port ||
      this.props.pathname !== prevProps.pathname ||
      this.props.secure !== prevProps.secure ||
      this.props.user !== prevProps.user ||
      this.props.realm !== prevProps.realm ||
      this.props.password !== prevProps.password ||
      this.props.autoRegister !== prevProps.autoRegister
    ) {
      // console.log('reactsip: reinitializeJsSIP'); // we dont seem to hit this ever..
      this.reinitializeJsSIP();
    }
  }

  componentWillUnmount(): void {
    if (this.ua) {
      // hangup all the calls
      this.terminateAll();
      this.ua.stop();
      this.ua = null;
    }
    if (this.mediaEngine) {
      // close all opened streams
      this.mediaEngine.closeAll();
    }
  }
  getActiveCall = (): SipCall | undefined => {
    const { callList } = this.state;
    const activeCall = callList.find((item) => item.isMediaActive() === true);
    return activeCall;
  };
  getLastCall = (): SipCall | undefined => {
    const { callList } = this.state;
    if (callList.length > 0) {
      return callList[callList.length - 1];
    }
  };
  isLineConnected = (): boolean => {
    return this.state.lineStatus === LINE_STATUS_CONNECTED;
  };
  isRegistered = (): boolean => {
    return this.state.sipStatus === SIP_STATUS_REGISTERED;
  };
  hasError = (): boolean => {
    return this.state.errorType !== SIP_ERROR_TYPE_NONE;
  };
  getErrorMessage = (): string => {
    return this.state.errorMessage;
  };

  isCallAllowed = (): boolean => {
    if (!this.mediaEngine) {
      this.logger.debug('Media device is not ready')
      return false;
    }
    // registration check required ??
    if (!this.isRegistered()) {
      this.logger.error('Sip device is not registered with the network');
      return false;
    }
    // check if max call limit has reached
    if (this.state.callList.length >= this.props.maxAllowedCalls) {
      this.logger.debug('Max allowed call limit has reached')
      return false;
    }
    // check if any calls are in establishing state
    // dont allow new call, if one is still in progress state
    const { callList } = this.state;
    const  establishing = callList.find((call) => { return call.isEstablishing() === true });
    // Already a call is
    if (establishing && establishing !== undefined) {
      this.logger.debug('Already a call is in establishing state');
      return false;
    }
    // TODO Allow even in dialing state ??
    return true;
  };

  registerSip(): void {
    if (!this.ua) {
      throw new Error(`Calling registerSip is not allowed when JsSIP.UA isn't initialized`);
    }
    if (this.props.autoRegister) {
      throw new Error('Calling registerSip is not allowed when autoRegister === true');
    }
    if (this.state.lineStatus !== LINE_STATUS_CONNECTED) {
      throw new Error(
        `Calling registerSip is not allowed when line status is ${this.state.lineStatus} (expected ${LINE_STATUS_CONNECTED})`,
      );
    }
    this.ua.register();
  }
  unregisterSip(options?: UnRegisterOptions): void {
    if (!this.ua) {
      throw new Error("Calling unregisterSip is not allowed when JsSIP.UA isn't initialized");
    }
    if (this.state.sipStatus !== SIP_STATUS_REGISTERED) {
      throw new Error(
        `Calling unregisterSip is not allowed when sip status is ${this.state.sipStatus} (expected ${SIP_STATUS_REGISTERED})`,
      );
    }
    this.ua.unregister(options);
  }

  makeCall = (callee: string, isVideoCall: boolean): string => {
    if (!callee) {
      throw new Error(`Destination must be defined (${callee} given)`);
    }
    if (!this.ua) {
      throw new Error("Calling startCall is not allowed when JsSIP.UA isn't initialized");
    }
    if (!this.isLineConnected()) {
      throw new Error(`Phone is not connected to the network, current state - ${this.state.lineStatus}`);
    }
    if (!this.isCallAllowed()) {
      throw new Error(`Max limit reached, new calls are not allowed`);
    }
    // check if any active calls are present or not
    const { callList } = this.state;
    const activeCall = callList.find((item) => item.isMediaActive());
    if (activeCall) {
      // TODO : Auto Hold
      throw new Error(`An active call found, hold the call before making new call`);
    }
    // create sip call configuartion
    const rtcConfig = this.getRTCConfig();
    const dtmfOptions = this.getDtmfOptions();
    // @ts-ignore
    const sipCall = new SipCall(
      false,
      callee,
      this.getCallConfig(),
      rtcConfig,
      dtmfOptions,
      this.mediaEngine,
      this.eventBus
    );
    const ua = this.getUA();

    // create Input MediaStream from MediaDevice
    // @ts-ignore
    sipCall.dial(ua, callee, true, true);
    callList.push(sipCall);
    this.setState({ callList });

    return sipCall.getId();
  };

  // Clear all existing sessions from the UA
  terminateAll = () => {
    if (!this.ua) {
      throw Error(`UA is not connected`);
    }
    this.ua.terminateSessions();
  };
  reconfigureDebug(): void {
    const { debug } = this.props;
    if (debug) {
      JsSIP.debug.enable(this.props.debugNamespaces || 'JsSIP:*');
      this.logger = console;
    } else {
      JsSIP.debug.disable();
      this.logger = dummyLogger;
    }
  }

  async reinitializeJsSIP(): Promise<void> {
    if (this.ua) {
      this.ua.stop();
      this.ua = null;
    }
    const { socket, user, password, realm, autoRegister } = this.props;
    this.localAddr = `${user}@${realm}`;

    if (!user) {
      this.setState({
        sipStatus: SIP_STATUS_UNREGISTERED,
        errorType: SIP_ERROR_TYPE_CONFIGURATION,
        errorMessage: 'user parameter is missing in config',
      });
      return;
    }
    try {
      const socketJsSip = new JsSIP.WebSocketInterface(socket);
      this.ua = new JsSIP.UA({
        // Modify to user@domain
        uri: `${user}@${realm}`,
        authorization_user: user,
        realm,
        password,
        sockets: [socketJsSip],
        register: autoRegister,
        session_timers: this.uaConfig?.sessionTimers,
        // instance_id  - ADD UUID here
        // registrar_server: this.uaConfig?.registrar,
        // register_expires: this.uaConfig?.registerExpires,
        // user_agent: this.uaConfig?.userAgent,
      });
      // @ts-ignore
      window.UA = this.ua;
      // @ts-ignore
      window.UA_SOCKET = socketJsSip;
    } catch (error) {
      // tslint:disable-next-line:no-console
      console.log(error.message);
      this.setState({
        sipStatus: SIP_STATUS_ERROR,
        errorType: SIP_ERROR_TYPE_CONFIGURATION,
        errorMessage: error.message,
      });
      this.logger.debug(error.message);
      return;
    }

    const { ua, eventBus } = this;
    ua.on('connecting', () => {
      this.logger.debug('UA "connecting" event');
      if (this.ua !== ua) {
        return;
      }
      this.setState({
        lineStatus: LINE_STATUS_CONNECTING,
      });
    });

    ua.on('connected', () => {
      this.logger.debug('UA "connected" event');
      if (this.ua !== ua) {
        return;
      }
      this.setState({
        lineStatus: LINE_STATUS_CONNECTED,
        errorType: SIP_ERROR_TYPE_NONE,
        errorMessage: '',
      });
    });

    ua.on('disconnected', () => {
      this.logger.debug('UA "disconnected" event');
      if (this.ua !== ua) {
        return;
      }
      this.setState({
        lineStatus: LINE_STATUS_DISCONNECTED,
        sipStatus: SIP_STATUS_ERROR,
        errorType: SIP_ERROR_TYPE_CONNECTION,
        errorMessage: 'disconnected',
      });
    });

    ua.on('registered', (data) => {
      this.logger.debug('UA "registered" event', data);
      if (this.ua !== ua) {
        return;
      }
      this.setState({
        sipStatus: SIP_STATUS_REGISTERED,
        errorType: SIP_ERROR_TYPE_NONE,
        errorMessage: '',
      });
    });

    ua.on('unregistered', () => {
      this.logger.debug('UA "unregistered" event');
      if (this.ua !== ua) {
        return;
      }
      this.setState({
        sipStatus: SIP_STATUS_UNREGISTERED,
      });
    });

    ua.on('registrationFailed', (data) => {
      this.logger.debug('UA "registrationFailed" event');
      // tslint:disable-next-line:no-console
      console.log(data.response.reason_phrase);
      if (this.ua !== ua) {
        return;
      }
      this.setState({
        sipStatus: SIP_STATUS_ERROR,
        errorType: SIP_ERROR_TYPE_REGISTRATION,
        errorMessage: data.cause || data.response.reason_phrase,
      });
    });

    ua.on('newRTCSession', (data) => {
      const { callList } = this.state;
      // @ts-ignore
      if (!this || this.ua !== ua) {
        return;
      }
      // check the originator
      const { originator, session } = data;
      // INCOMING CALL
      if (originator === 'remote') {
        let remoteName = session.remote_identity.display_name;
        if(remoteName === null || remoteName === '') {
          remoteName = session.remote_identity.uri.user;
        }
        if (!this.isCallAllowed()) {
          const rejectOptions = {
            status_code: 486,
            reason_phrase: 'Busy Here',
          };
          session.terminate(rejectOptions);
          return;
        }

        // @ts-ignore
        const sipCall: SipCall = new SipCall(
          true,
          remoteName,
          this.getCallConfig(),
          this.getRTCConfig(),
          this.getDtmfOptions(),
          this.mediaEngine,
          this.eventBus
        );
        sipCall.onNewRTCSession(session);
        callList.push(sipCall);
        this.setState({ callList });

      } else {
        // fetch
        const outCall = callList.find((call) => call.isDialing() === true);
        if (outCall !== undefined) {
          outCall.onNewRTCSession(session);
        }
      }
    });

    // CALL UPDATE
    eventBus!.on('call.update', (event) => {
      const { call } = event;
      const { callList } = this.state;
      // tslint:disable-next-line:no-console
      console.log('Event emitter on call.update');
      // tslint:disable-next-line:no-console
      console.log(event.call.getCallStatus());

      const index = callList.findIndex((item) => item.getId() === call.getId());
      if (index !== -1) {
        callList[index] = call;
        this.setState({ callList });
      }
    });
    // CALL ENDED
    eventBus!.on('call.ended', (event) => {
      const { call } = event;
      const { callList } = this.state;
      // tslint:disable-next-line:no-console
      console.log('Event emitter on call.ended');
      const index = callList.findIndex((item) => item.getId() === call.getId());
      if (index !== -1) {
        callList.splice(index, 1);
        this.setState({ callList });
      }
      // add the call to history
      const callHistory = [call, ...this.state.callHistory];
      this.setState({ callHistory });
    });

    const extraHeadersRegister = this.props.extraHeaders.register || [];
    if (extraHeadersRegister.length) {
      ua.registrator().setExtraHeaders(extraHeadersRegister);
    }
    ua.start();
  }

  render(): React.ReactNode {
    return this.props.children;
  }
}
