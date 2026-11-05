import { provideZoneChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { AppComponent } from './app/app.component';
import { authInterceptor } from './app/api.service';
bootstrapApplication(AppComponent, { providers: [provideZoneChangeDetection(), provideHttpClient(withInterceptors([authInterceptor]))] }).catch(console.error);
